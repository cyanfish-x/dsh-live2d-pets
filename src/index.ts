/**
 * dsh-live2d-pets host 半区：注册宠物服务、settings namespace 与同源 HTTP 路由。
 * 官方插件形态（docs/user/develop/basic/publish.md）：组合包 bundle，
 * 配置经 Schemastery Config schema 传入，并注册为 settings namespace
 * （base = cordis.yml 插件行 config，用户层覆盖，settings.yaml 持久化）。
 * @module dsh-live2d-pets
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { PetService } from './service.ts'
import { makePetRoutes, petPackageRoot, type SettingsRoutesApi } from './routes.ts'
import type { CustomModelEntry } from './models.ts'
import { listBuiltinPresets, resolveModelUrl, resolveSpatialTap, resolveMotionMap } from './models-host.ts'
import { PersonasStore } from './personas.ts'
import { CustomModelsStore } from './custom-models.ts'

export { PetService } from './service.ts'
export type { PetState, PetStateView } from './service.ts'
export { makePetRoutes, petPackageRoot, PET_API_PREFIX, PET_ASSET_PREFIX } from './routes.ts'
export {
  listBuiltinPresets,
  resolveModelUrl,
  resolveSpatialTap,
  resolveMotionMap,
} from './models-host.ts'
export {
  mergeSpatialTap,
  DEFAULT_SPATIAL_TAP,
  DEFAULT_MOTION_MAP,
  ANIMATION_SLOTS,
} from './models.ts'
export type {
  BuiltinPreset,
  CustomModelEntry,
  SpatialTapConfig,
  SpatialTapOverride,
  AnimationSlot,
  MotionMap,
} from './models.ts'

/** 稳定 cordis 插件名（对应 cordis.patch.yml insert id）。 */
export const name = 'live2d-pet'

/** settings namespace（settings.yaml 用户层 section 名）。 */
export const SETTINGS_NAMESPACE = 'live2d-pet'

/** 品牌化 namespace（dsh-settings 类型约束）。 */
const NS = settingsNamespace(SETTINGS_NAMESPACE)

/** 渲染帧率档（spec §2/§7）：30 / 60 / 0（不限制，对应 PIXI maxFPS=0）。 */
export type MaxFpsOption = 30 | 60 | 0

export interface Config {
  /** 插件总开关。 */
  enabled: boolean
  /** 宠物尺寸（px，滑杆 40–400）。 */
  size: number
  /** 渲染帧率上限（30 / 60 / 0=不限制；默认 30）。 */
  maxFps: MaxFpsOption
  /** 选中模型：内置 preset id 或自定义模型 id（也兼容直接 URL）。 */
  model: string
  /** 开发者选项总开关：开启后显示调试面板/点击分区等开发者入口。 */
  developerMode: boolean
  /** 调试面板：显示调试面板（开发用）。 */
  debug: boolean
  /** 显示点击分区叠加层（空间回退色块，开发用）。 */
  showTapZones: boolean
  /** @deprecated 自定义模型已迁移到 $DSH_HOME/live2d-pet/custom-models.jsonc，不再写 settings.yaml。 */
  customModels?: CustomModelEntry[]
  /** 选中人设 id：内置（tsundere/genki/…）或自定义人设 id（spec §3）。 */
  persona: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  size: Schema.number().min(40).max(400).default(160),
  maxFps: Schema.union([
    Schema.const(30),
    Schema.const(60),
    Schema.const(0),
  ]).default(30),
  model: Schema.string().default('hiyori'),
  developerMode: Schema.boolean().default(false),
  debug: Schema.boolean().default(false),
  showTapZones: Schema.boolean().default(false),
  persona: Schema.string().default('tsundere'),
})

/** 依赖服务：webServer（同源路由）、settings（namespace 注册与解析）。 */
export const inject = ['webServer', 'settings']

/** 注册宠物服务、settings namespace 及其 API + 素材路由。 */
export function apply(ctx: Context, config: Config): void {
  // 注册 settings namespace：base = 本条 cordis.yml 条目 config 子集，
  // 用户层（settings.yaml）覆盖其上；注册随插件 fiber 自动清理。
  ctx.settings.register(NS, Config, { base: config })

  // 解析值优先（三层：schema 默认 → base → 用户层），未注册时回落 entry config。
  const resolveConfig = (): Config => {
    const resolved = ctx.settings.get(NS) as Config | undefined
    return resolved ?? config
  }

  const customModelsStore = new CustomModelsStore()
  // 旧数据迁移：settings.yaml 里若还有 customModels 且新文件为空，则一次性写入 custom-models.jsonc
  const initialConfig = resolveConfig()
  if (initialConfig.customModels?.length && customModelsStore.load().models.length === 0) {
    customModelsStore.write(initialConfig.customModels)
  }
  const service = new PetService(ctx, resolveConfig, new PersonasStore(), customModelsStore)

  // 设置读写 API：Host 直连 ctx.settings（不走 wire 白名单——dsh-host-apiproxy
  // 只暴露内置 allowlist，第三方 namespace 见 research/settings-tab.md）。
  // 写完成后通知 PetService，经 SSE 端点推送新配置（ADR-006）。
  const settingsApi: SettingsRoutesApi = {
    view: () => ({ value: resolveConfig(), writable: ctx.settings.writable }),
    write: (ops: readonly SettingsPathOp[]) => ctx.settings.mutate(NS, ops).then(() => {
      service.notifyConfigChanged()
    }),
  }

  // 「选择本地文件」不依赖 DSH 的 directoryPicker 服务（该服务须另行加载
  // native 后端插件，未加载时访问会抛「without inject」）。改为插件自研：
  // 由 Host 侧 Node fs 直接扫描目录（POST /api/live2d-pet/list-local-dir），
  // 客户端逐级导航并选中 `.model3.json` 文件回填绝对路径。
  // 路由随插件生命周期注册/清理；配置变更（HMR / settings 热更新）经 resolveConfig 即时反映。
  // 插件卸载时同时关闭全部活跃 SSE 流（onStream），避免旧流在路由注销后空转心跳。
  ctx.effect(() => {
    const openStreams = new Set<() => void>()
    const routes = makePetRoutes({
      service,
      packageRoot: petPackageRoot(import.meta.url),
      settings: settingsApi,
      onStream: (close) => { openStreams.add(close) },
    })
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const close of openStreams) close()
      for (const dispose of disposers) dispose()
    }
  }, 'live2d-pet: routes')
}
