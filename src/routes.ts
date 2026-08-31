/**
 * 宠物 HTTP 路由：浏览器半区通过同源 JSON 端点（/api/live2d-pet/*）、
 * SSE 状态推送端点（/api/live2d-pet/events，ADR-006）与素材静态路由
 * （/pet-assets/*）通信——官方模式（dsh-pet routes.ts 同款，见 docs/adr/004）。
 * @module dsh-live2d-pets/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PetService } from './service.ts'
import { listBuiltinPresets } from './models-host.ts'
import type { CustomModelEntry } from './models.ts'
import { isLocalModelPath } from './models.ts'
import { resolveLocalModelFile, listLocalDir } from './local-models.ts'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** 设置读写 API（Host 直连 ctx.settings；不走 wire 白名单，见 research/settings-tab.md）。 */
export interface SettingsRoutesApi {
  view(): { value: unknown; writable: boolean }
  write(ops: readonly SettingsPathOp[]): Promise<void>
}

/** 浏览器侧宠物 API 基路径。 */
export const PET_API_PREFIX = '/api/live2d-pet'

/** 浏览器侧素材静态路由基路径（vendor 运行时脚本 + 预设模型）。 */
export const PET_ASSET_PREFIX = '/pet-assets'

/** 本地模型静态路由基路径（Host 按自定义模型 id 映射到用户本地路径）。 */
export const PET_LOCAL_MODELS_PREFIX = '/pet-local-models'

/** 随包暴露的素材清单（路径相对于 package 根）。 */
const ASSET_FILES = [
  { name: 'vendor/pixi.min.js', mime: 'text/javascript' },
  { name: 'vendor/live2dcubismcore.min.js', mime: 'text/javascript' },
  { name: 'vendor/live2d-display.cubism4.min.js', mime: 'text/javascript' },
] as const

/** 包根目录（从本模块自身位置解析）。 */
export function petPackageRoot(importMetaUrl: string): string {
  return fileURLToPath(new URL('../', importMetaUrl))
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  json(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body-too-large'))
        queueMicrotask(() => req.destroy())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

function getRoute(path: string, run: () => Promise<unknown>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!requireMethod(req, res, 'GET')) return
      run().then((value) => json(res, 200, value), (error) => {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    },
  }
}

function postRoute(path: string, run: (body: Record<string, unknown>) => Promise<unknown>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!requireMethod(req, res, 'POST')) return Promise.resolve()
      return readJsonBody(req).then((body) => {
        const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
        return run(record).then(
          (value) => json(res, 200, value),
          (error) => json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
      }, (error) => {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    },
  }
}

/**
 * 同一 path 上挂 GET + POST（webServer 按 path 唯一注册，不按 method 分表；
 * 见 dsh-host-webserver register：duplicate exact route）。
 */
function getPostRoute(
  path: string,
  get: () => Promise<unknown>,
  post: (body: Record<string, unknown>) => Promise<unknown>,
): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): void | Promise<void> => {
      if (req.method === 'GET') {
        return get().then((value) => json(res, 200, value), (error) => {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        })
      }
      if (req.method === 'POST') {
        return readJsonBody(req).then((body) => {
          const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
          return post(record).then(
            (value) => json(res, 200, value),
            (error) => json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }),
          )
        }, (error) => {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        })
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    },
  }
}

/** SSE 心跳间隔（ms）：保持空闲连接活性，防止被中间层/浏览器回收。 */
const SSE_HEARTBEAT_MS = 30_000

/**
 * SSE 状态推送端点（ADR-006）：连接即回发当前快照，之后每次服务变化
 * （状态/显示/配置）推送新快照。EventSource 断线自动重连（retry 3s），
 * 重连后服务端立即回发快照，客户端无需补偿拉取。
 * @param onStream - 路由生命周期钩子：插件卸载时由调用方关闭全部活跃流。
 */
function sseStateRoute(
  path: string,
  service: PetService,
  onStream?: (close: () => void) => void,
): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // 断线后写入会抛错，吞掉避免未处理异常
      res.on('error', () => {})
      res.write('retry: 3000\n\n')
      const send = () => { res.write(`data: ${JSON.stringify(service.snapshot())}\n\n`) }
      send()
      const unsubscribe = service.onChange(send)
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, SSE_HEARTBEAT_MS)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        unsubscribe()
        clearInterval(heartbeat)
        try { res.end() } catch { /* 连接已关闭 */ }
      }
      req.on('close', close)
      res.on('close', close)
      onStream?.(close)
    },
  }
}

/** 简单 MIME 推断（本地模型资源路由用）。 */
function mimeForFile(file: string): string {
  const lower = file.toLowerCase()
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.bin') || lower.endsWith('.moc3')) return 'application/octet-stream'
  return 'application/octet-stream'
}

/** 构建完整路由族（API + SSE + 素材）供 ctx.webServer.register。 */
export function makePetRoutes(deps: {
  service: PetService
  packageRoot: string
  settings: SettingsRoutesApi
  /** SSE 活跃流注册钩子：插件卸载时由调用方逐一 close（ADR-006）。 */
  onStream?: (close: () => void) => void
}): WebRoute[] {
  const { service, packageRoot, settings, onStream } = deps
  const apiRoutes: WebRoute[] = [
    sseStateRoute(`${PET_API_PREFIX}/events`, service, onStream),
    getRoute(`${PET_API_PREFIX}/state`, async () => service.snapshot()),
    getRoute(`${PET_API_PREFIX}/models`, async () => ({
      builtin: listBuiltinPresets(),
      custom: service.listCustomModels(),
      presetsPath: join(packageRoot, 'src', 'presets', 'presets.jsonc'),
      customModelsPath: service.customModelsFile().path,
    })),
    // 「选择本地文件」：不依赖 DSH 的 directoryPicker 服务，插件自研浏览——
    // Host 侧直接用 Node fs 列出目录，客户端逐级导航并选中 `.model3.json` 文件，
    // 回填其绝对路径到设置页 URL 框（见 settings.ts 目录浏览弹层）。
    postRoute(`${PET_API_PREFIX}/list-local-dir`, (body) => {
      const target = typeof body.path === 'string' ? body.path : null
      const listing = listLocalDir(target)
      if (!listing) return Promise.resolve({ ok: false, error: 'directory-unreadable', listing: null })
      return Promise.resolve({ ok: true, listing })
    }),
    getPostRoute(
      `${PET_API_PREFIX}/custom-models`,
      async () => service.customModelsFile(),
      (body) => {
        const models = Array.isArray(body.models) ? body.models as CustomModelEntry[] : []
        return Promise.resolve(service.saveCustomModels(models))
      },
    ),
    getPostRoute(
      `${PET_API_PREFIX}/settings`,
      async () => settings.view(),
      (body) => {
        const ops = Array.isArray(body.ops) ? body.ops as SettingsPathOp[] : []
        return settings.write(ops).then(() => settings.view())
      },
    ),
    postRoute(`${PET_API_PREFIX}/set-display`, (body) => {
      const patch: { right?: number; bottom?: number; size?: number } = {}
      if (typeof body.right === 'number') patch.right = body.right
      if (typeof body.bottom === 'number') patch.bottom = body.bottom
      if (typeof body.size === 'number') patch.size = body.size
      return Promise.resolve({ ok: true, display: service.setDisplay(patch) })
    }),
    postRoute(`${PET_API_PREFIX}/reset-display`, () => Promise.resolve({ ok: true, display: service.resetDisplay() })),
    // 人设文件重读（spec §2「↻ 重新读取」）：现读 JSONC 文件 + SSE 推送，宠物与下拉当场更新
    postRoute(`${PET_API_PREFIX}/reload-personas`, () => {
      const view = service.reloadPersonas()
      return Promise.resolve({ ok: true, personas: view.personas, error: view.error, file: view.path })
    }),
  ]

  const localModelRoute: WebRoute = {
    kind: 'prefix',
    path: PET_LOCAL_MODELS_PREFIX,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return Promise.resolve()
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)
      // /pet-local-models/<id>/<relative...>
      if (parts.length < 3) {
        res.writeHead(404)
        res.end()
        return Promise.resolve()
      }
      const id = decodeURIComponent(parts[1])
      const relativePath = parts.slice(2).map(decodeURIComponent).join('/')
      const entry = service.listCustomModels().find((c) => c.id === id)
      if (!entry || !isLocalModelPath(entry.modelUrl)) {
        res.writeHead(404)
        res.end()
        return Promise.resolve()
      }
      const file = resolveLocalModelFile(entry.modelUrl, relativePath)
      if (!file) {
        res.writeHead(404)
        res.end()
        return Promise.resolve()
      }
      return readFile(file).then((body) => {
        res.writeHead(200, {
          'content-type': mimeForFile(file),
          'content-length': String(body.byteLength),
          'cache-control': 'no-cache',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(body)
      }, () => {
        res.writeHead(404)
        res.end()
      })
    },
  }

  const assetRoutes: WebRoute[] = ASSET_FILES.map((file): WebRoute => ({
    kind: 'exact',
    path: `${PET_ASSET_PREFIX}/${file.name}`,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> | void => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      return readFile(join(packageRoot, 'assets', file.name)).then((body) => {
        res.writeHead(200, {
          'content-type': file.mime,
          'content-length': String(body.byteLength),
          'cache-control': 'no-cache',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(body)
      }, () => {
        res.writeHead(404)
        res.end()
      })
    },
  }))

  return [...apiRoutes, ...assetRoutes, localModelRoute]
}
