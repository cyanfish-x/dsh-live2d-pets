/**
 * dsh-live2d-pets 浏览器半区：挂载 Live2D 桌宠 + 「桌宠配置」设置页。
 *
 * 架构（ADR-005 / 004，spike pkg-9 实证）：
 * - `shell.overlay` 注册零尺寸锚点（生命周期/设置锚点）
 * - 视觉层用 Popover API（top layer，零 z-index）渲染，旧浏览器回退 body + 最大 z-index
 * - 运行时脚本与预设模型走 Host 同源路由（/pet-assets/*），无 CDN 依赖
 * - agent 状态经 /api/live2d-pet/events SSE 推送（首帧快照 + 变更推送，ADR-006）；
 *   标签页隐藏/窗口失焦暂停渲染循环，恢复时继续（spec §7）
 * - 点击/拖动按 6px 阈值判定；自由位置拖动，松手持久化（spec §4）
 * - 鼠标跟随：document 级 pointermove 调用 model.focus()，头/眼/身体看向鼠标；移出页面复位；
 *   非 idle 动作播放期间抑制 focus，避免动作关键帧被鼠标跟随叠加（spec §4）
 * - 配置（enabled/size/maxFps/debug/model）经状态推送运行时应用：开关→显隐+停启渲染、
 *   尺寸→重设画布与模型适配、帧率→ticker.maxFPS、调试→动态面板、模型→按 modelUrl 重载（spec §2/§6/§7）
 * @module dsh-live2d-pets/client
 */

import { createElement, useEffect, useRef } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type { PetState, PetStateView } from '../service.ts'
import { PetSettingsSection } from './settings.ts'
import { installPetSettingsNavIcon, pawNavIcon } from './paw-icon.ts'
import { resolvePersonaCopy, BUILTIN_PERSONAS } from './personas.ts'
import type { CopyTable } from '../persona-shared.ts'
import { DEFAULT_PERSONA_ID } from '../persona-shared.ts'
import {
  DEFAULT_MOTION_MAP,
  DEFAULT_SPATIAL_TAP,
  type AnimationSlot,
  type MotionMap,
  type SpatialTapConfig,
} from '../models.ts'

/** 注入所需服务。 */
export const inject = ['slots']

/** 点击/拖动判定阈值（px）。 */
const DRAG_THRESHOLD = 6
/** 点击互动防抖（ms）：仅挡同一次 pointer 误触双发，不等气泡播完（spec §4）。 */
const TAP_DEBOUNCE_MS = 80
/** 瞬态气泡显示时长（ms）：到时自动隐藏或回落阶段文案。 */
const BUBBLE_DISPLAY_MS = 2500
/**
 * 默认渲染帧率上限（spec §2/§7）：未封顶时 PIXI ticker 可达 120–140fps，
 * 长时间挂页会持续占满 GPU/主线程；桌宠动画默认 30fps 足够，用户可在设置中改档。
 */
const DEFAULT_MAX_FPS = 30

/** pixi-live2d-display MotionPriority（对应库内枚举：NONE=0, IDLE=1, NORMAL=2, FORCE=3）。 */
const MotionPriority = {
  IDLE: 1,
  NORMAL: 2,
  FORCE: 3,
} as const
type MotionPriority = typeof MotionPriority[keyof typeof MotionPriority]

/** 归一化配置帧率档（非法值回落默认 30）。 */
function normalizeMaxFps(raw: unknown): number {
  if (raw === 60 || raw === 0) return raw
  return DEFAULT_MAX_FPS
}
/**
 * 阶段演进气泡（spec §3）：思考/等审批为长状态（可达数十秒以上），气泡与
 * 状态同生命周期**常驻**，文案按入态后耗时推进（afterMs 为距入态偏移），
 * 阶段切换时重播一次状态动作；状态一变即被新状态表现取代。
 * 文案取自当前人设台词表（thinking1..3 / waiting1..3，spec §3 人设化台词）。
 */
const STAGED_DELAYS: Partial<Record<PetState, number[]>> = {
  thinking: [0, 15_000, 40_000],
  waiting: [0, 30_000, 90_000],
}
/** 长状态阶段文案池键。 */
type StageCopyKey = 'thinking1' | 'thinking2' | 'thinking3' | 'waiting1' | 'waiting2' | 'waiting3'
/** 长状态 → 台词池键（与 STAGED_DELAYS 下标对应）。 */
const STAGED_COPY_KEYS: Partial<Record<PetState, StageCopyKey[]>> = {
  thinking: ['thinking1', 'thinking2', 'thinking3'],
  waiting: ['waiting1', 'waiting2', 'waiting3'],
}
/** 短状态（瞬态气泡）→ 台词池键；无键的状态不冒泡。 */
const TRANSIENT_COPY_KEYS: Partial<Record<PetState, 'idle' | 'error' | 'done'>> = {
  idle: 'idle',
  error: 'error',
  done: 'done',
}
/** vendor 运行时脚本（Host 同源路由，ADR-003）。 */
const VENDOR_SCRIPTS = [
  '/pet-assets/vendor/pixi.min.js',
  '/pet-assets/vendor/live2dcubismcore.min.js',
  '/pet-assets/vendor/live2d-display.cubism4.min.js',
]

const PET_API = '/api/live2d-pet'

/** PIXI 全局（script 注入，非模块导入）。 */
declare const PIXI: {
  Application: new (options: Record<string, unknown>) => {
    stage: { addChild(child: unknown): unknown }
    ticker: {
      addOnce(fn: () => void): unknown
      start(): unknown
      stop(): unknown
      maxFPS?: number
    }
    renderer: { resize(width: number, height: number): unknown }
    destroy(remove: boolean): void
  }
  Point: new (x: number, y: number) => unknown
  live2d?: {
    Live2DModel?: {
      from(url: string, options?: Record<string, unknown>): Promise<unknown>
    }
  }
}

/** 最小 slots 服务结构类型（运行时由 DSH 提供）。 */
interface SlotsLike {
  inject(key: string, callback: () => () => void): () => void
  register(
    options: {
      name: string
      id: string
      order?: number
      label?: string | (() => string)
      /** 设置导航图标：ReactNode 或按尺寸渲染（与 better-sidebar 等同款约定）。 */
      icon?: ReactNode | ((size: number) => ReactNode)
      inject?: () => Record<string, unknown>
    },
    component: (props: unknown) => unknown,
  ): () => void
}

interface DisplayLike { right: number; bottom: number; size: number }

/** 调试预览用：模型中的一个具体动画（动作组 + 组内下标 + 展示名）。 */
interface DebugMotionItem {
  group: string
  index: number
  label: string
}

interface ModelLike {
  width: number
  height: number
  anchor: { set(x: number, y: number): void }
  scale: { set(s: number): void }
  position: { set(x: number, y: number): void }
  /** pixi-live2d-display 真实签名：motion(group, index?, priority?)，只传组名时随机播放该组并默认 NORMAL。 */
  motion(name: string, index?: number, priority?: MotionPriority): Promise<boolean>
  /** pixi-live2d-display 真实签名：focus(x, y) 吃 world space 坐标，内部平滑映射头/眼/身体参数。 */
  focus(x: number, y: number, instant?: boolean): void
  /** pixi-live2d-display 真实签名：hitTest(x, y) 返回**命中的区域名数组**（spec §4）。 */
  hitTest(x: number, y: number): string[]
  /** 模型在舞台/画布坐标下的包围盒（空间分档回退用）。 */
  getBounds?: () => { x: number; y: number; width: number; height: number }
  internalModel?: {
    hitAreas?: Record<string, unknown>
    focusController?: { focus(x: number, y: number, instant?: boolean): void }
    motionManager?: {
      /** MotionManager 事件：motionFinish 是动作真正播完的信号（motion() 的 Promise 只代表开始）。 */
      on?(event: 'motionFinish', listener: () => void): unknown
      off?(event: 'motionFinish', listener: () => void): unknown
      /** 停掉当前队列并复位 MotionState；重播同一动作前需要先调用。 */
      stopAllMotions?(): void
      /** 模型定义的动作组名 → 动作定义列表（debug 预览枚举用）。 */
      definitions?: Record<string, unknown>
    }
  }
}

/** 互动部位（spec §4 四档分部位）。 */
type TapPart = 'head' | 'leg' | 'arm' | 'body'

/** 命中区域名 → 部位分桶（正则容错：不同模型命名不一）；未匹配的命中区域归身体。 */
const TAP_PART_MATCHERS: Array<{ part: TapPart; re: RegExp }> = [
  { part: 'head', re: /head|hair|face|头/i },
  { part: 'leg', re: /leg|foot|feet|shoe|腿|脚/i },
  { part: 'arm', re: /arm|hand|手/i },
]

/**
 * 按命中区域名优先级归类（头 > 腿 > 手 > 身体）；空列表返回 null。
 */
function classifyTapByName(hits: readonly string[]): TapPart | null {
  if (hits.length === 0) return null
  for (const { part, re } of TAP_PART_MATCHERS) {
    if (hits.some((name) => re.test(name))) return part
  }
  return 'body'
}

/**
 * 按点击在模型包围盒内的相对位置分档（spec §4：HitArea 不足时的空间回退）。
 * 五个矩形：头 / 身 / 腿（居中列）+ 左臂 / 右臂（侧列）；不落在任一矩形 → null。
 */
function classifyTapByPosition(
  localX: number,
  localY: number,
  bounds: { x: number; y: number; width: number; height: number },
  tap: SpatialTapConfig,
): TapPart | null {
  if (!(bounds.width > 0 && bounds.height > 0)) return null
  const nx = (localX - bounds.x) / bounds.width
  const ny = (localY - bounds.y) / bounds.height
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null
  if (ny < tap.headMaxNy && nx >= tap.headMinNx && nx <= tap.headMaxNx) return 'head'
  if (ny > tap.legMinNy && nx >= tap.bodyMinNx && nx <= tap.bodyMaxNx) return 'leg'
  if (ny >= tap.armMinNy && ny <= tap.legMinNy) {
    if (nx >= tap.armLeftMinNx && nx < tap.bodyMinNx) return 'arm'
    if (nx > tap.bodyMaxNx && nx <= tap.armRightMaxNx) return 'arm'
  }
  if (
    ny >= tap.headMaxNy
    && ny <= tap.legMinNy
    && nx >= tap.bodyMinNx
    && nx <= tap.bodyMaxNx
  ) return 'body'
  return null
}

/**
 * 综合命中名与空间回退（spec §4）：
 * - 命中名为头/腿/手 → 直接采用
 * - 空命中或仅身体/未识别名 → 盒内按相对位置分档；盒外不响应
 */
function classifyTap(
  hits: readonly string[],
  localX: number,
  localY: number,
  _hitAreaKeys: readonly string[],
  bounds: { x: number; y: number; width: number; height: number } | null,
  tap: SpatialTapConfig,
): TapPart | null {
  const named = classifyTapByName(hits)
  if (named === 'head' || named === 'leg' || named === 'arm') return named
  if (bounds) {
    const spatial = classifyTapByPosition(localX, localY, bounds, tap)
    if (spatial !== null) return spatial
  }
  return named
}

/** 从台词池随机取一句；可选避开上一条（池 ≥2 时，spec §4）。 */
function pickLine(pool: readonly string[], avoid?: string): string | undefined {
  if (pool.length === 0) return undefined
  if (pool.length === 1) return pool[0]
  const candidates = avoid ? pool.filter((line) => line !== avoid) : pool
  const list = candidates.length > 0 ? candidates : pool
  return list[Math.floor(Math.random() * list.length)]
}

/** JSON 响应读取:非 2xx 抛错——错误响应不得当作合法视图/结果解析。 */
async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`http ${res.status}`)
  return await res.json() as T
}

const api = {
  state: (): Promise<PetStateView> => fetch(`${PET_API}/state`).then((res) => readJson<PetStateView>(res)),
  /** SSE 状态订阅（ADR-006）：每次推送回调最新快照；断线由 EventSource
   *  自动重连（服务端 retry 3s），重连后首帧即全量快照。返回退订函数。 */
  events: (onState: (view: PetStateView) => void, onError: () => void): (() => void) => {
    const es = new EventSource(`${PET_API}/events`)
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        onState(JSON.parse(ev.data) as PetStateView)
      } catch {
        // 忽略坏帧，等待下一条
      }
    }
    es.onerror = onError
    return () => es.close()
  },
  setDisplay: (patch: { right?: number; bottom?: number }): Promise<{ ok: boolean }> =>
    fetch(`${PET_API}/set-display`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((res) => readJson<{ ok: boolean }>(res)),
}

/** vendor 脚本加载去重：同一 src 只注入一次、只等待同一份结果
 * （boot 在 StrictMode/HMR 下会重复执行，避免二次注入与重复初始化）。 */
const scriptPromises = new Map<string, Promise<void>>()

function loadScript(src: string): Promise<void> {
  let pending = scriptPromises.get(src)
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.onload = () => resolve()
      s.onerror = () => reject(new Error(`script load failed: ${src}`))
      document.head.appendChild(s)
    })
    scriptPromises.set(src, pending)
  }
  return pending
}

/** 零尺寸锚点组件：占位 shell.overlay 席位，实际渲染在 popover 顶层容器。 */
function PetAnchor(): ReturnType<typeof createElement> {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => boot(ref.current), [])
  return createElement('div', { ref, style: { width: 0, height: 0 } })
}

function boot(anchor: HTMLDivElement | null): (() => void) | undefined {
  if (!anchor) return undefined
  const cleanup: Array<() => void> = []
  const pushCleanup = (fn: () => void) => { cleanup.push(fn) }

  // 卸载守卫：置位后 boot 的异步流程在每个 await 点提前退出，
  // 避免 StrictMode 双挂载 / HMR 重挂载时残留第二份 PIXI app、SSE 订阅与脚本注入。
  let disposed = false
  pushCleanup(() => { disposed = true })
  // 阶段推进/瞬态气泡计时随卸载清理（HMR/StrictMode 重挂载不残留）
  pushCleanup(() => { clearStages(); clearBubbleHideTimer() })
  pushCleanup(() => {
    if (sizeRaf) { window.cancelAnimationFrame(sizeRaf); sizeRaf = 0 }
    pendingSize = null
  })
  pushCleanup(() => { stopZoneLoop(); showSpatialZones = false })

  let box: HTMLDivElement | null = null
  let bubble: HTMLDivElement | null = null
  let debugEl: HTMLDivElement | null = null
  /** 调试面板“动画预览”数据：当前模型 MotionManager 暴露的全部具体动画。 */
  let debugMotionList: DebugMotionItem[] = []
  /** 按模型 URL 缓存原生动画列表，避免重复请求同一份 .model3.json。 */
  const motionListCache = new Map<string, DebugMotionItem[]>()
  let debugMotionSelect: HTMLSelectElement | null = null
  /** 调试面板状态文本容器：与演示按钮/动画预览并列，避免被 textContent 覆盖。 */
  let debugTextEl: HTMLDivElement | null = null
  /** 是否正处于 debug 原生动画预览：预览期间抑制 focus，结束后只恢复跟随，不触发状态恢复。 */
  let previewActive = false
  let canvas: HTMLCanvasElement | null = null
  /** 画布外包一层，便于绝对定位调试分区叠加层。 */
  let petLayer: HTMLDivElement | null = null
  let zoneOverlay: HTMLCanvasElement | null = null
  let showSpatialZones = false
  /** 当前模型生效的空间回退阈值（SSE config.spatialTap；默认 DEFAULT_SPATIAL_TAP）。 */
  let spatialTap: SpatialTapConfig = { ...DEFAULT_SPATIAL_TAP }
  /** 当前模型生效的状态/互动动画映射（SSE config.motionMap；默认 DEFAULT_MOTION_MAP）。 */
  let motionMap: MotionMap = { ...DEFAULT_MOTION_MAP }
  let zoneRaf = 0
  let app: {
    destroy(remove?: boolean): void
    stage: { addChild(child: unknown): unknown }
    ticker: {
      addOnce(fn: () => void): unknown
      start(): unknown
      stop(): unknown
      maxFPS?: number
    }
    renderer: { resize(width: number, height: number): unknown }
  } | null = null
  let model: ModelLike | null = null
  let hitAreas: string[] = []
  let currentModelUrl: string | null = null
  let fallbackShown = false
  let fallbackEl: HTMLDivElement | null = null
  // 模型基础尺寸（scale=1 时捕获一次；Pixi Container.width 含当前 scale，
  // 若每次 fit 都现读会按 1/s0 累积误差导致越放越大被画布裁剪）
  let baseModelW = 0
  let baseModelH = 0
  // 尺寸变更合并：SSE 连发时只落地最后一档，避免主线程串行多次 WebGL resize（实测单次可达数秒）
  let pendingSize: number | null = null
  let sizeRaf = 0
  let lastTapAt = 0
  /** 各点击台词池上一次抽中的句子（避开连抽同一句，spec §4）。 */
  const lastTapLine: Partial<Record<'tapHead' | 'tapLeg' | 'tapArm' | 'tapBody', string>> = {}
  /** 互动动作世代：新互动或新非 idle 状态动作会作废上一次互动的恢复回调。 */
  let interactionGen = 0
  /** 动作启动世代：任何新动作都会使异步 fallback/旧启动失效，避免被 stopAllMotions 打断后继续启动。 */
  let motionSeq = 0
  /** 是否正在播放互动动作（motionFinish 后据此恢复当前状态动作）。 */
  let interactionActive = false
  /** 是否抑制鼠标跟随：非 idle 动作播放期间为 true（spec §4）。 */
  let focusSuppressed = false
  /** 最近一次全局 pointermove 的 client 坐标；动作结束后用于立即恢复跟随。 */
  let lastPointerClient: { x: number; y: number } | null = null
  /** 当前模型 motionManager 的 motionFinish 解绑函数（模型重载/卸载时清理）。 */
  let detachMotionFinish: (() => void) | null = null
  let bubbleHideTimer: number | undefined
  let stageTimers: number[] = []
  let stagedState: PetState | null = null
  let stageIndex = 0
  let lastState: PetState | null = null
  let demoState: PetState | null = null
  let view: PetStateView | null = null
  let pos: DisplayLike = { right: 24, bottom: 20, size: 160 }
  // 帧率档（settings maxFps → ticker.maxFPS；0 = 不限制）
  let maxFps = DEFAULT_MAX_FPS
  // 渲染开关：插件 enabled（配置）与页面可见性（spec §7）共同决定 ticker 是否运行
  let enabled = true
  let hidden = document.visibilityState !== 'visible'
  // 当前人设台词表（spec §3：内置常量 or 自定义 base 链合并；人设切换时热更新）
  let activePersonaId: string = DEFAULT_PERSONA_ID
  let activeCopy: CopyTable = resolvePersonaCopy(DEFAULT_PERSONA_ID, [])
  let lastCustomPersonas: PetStateView['customPersonas'] = []
  let personaDefsVersion = -1

  /** 合并 enabled/隐藏/失焦状态，启停渲染循环（spec §7：暂停渲染保留最后画面）。 */
  function syncTicker(): void {
    if (!app) return
    const shouldRun = enabled && !hidden
    if (shouldRun) { try { app.ticker.start() } catch { /* 已启动 */ } }
    else { try { app.ticker.stop() } catch { /* 已停止 */ } }
  }

  /** 应用渲染帧率上限（spec §2/§7；0 = PIXI 不设上限）。 */
  function applyMaxFps(next: number): void {
    maxFps = normalizeMaxFps(next)
    if (!app?.ticker) return
    try { app.ticker.maxFPS = maxFps } catch { /* 旧 ticker */ }
  }

  function clearBubbleHideTimer(): void {
    if (bubbleHideTimer !== undefined) {
      window.clearTimeout(bubbleHideTimer)
      bubbleHideTimer = undefined
    }
  }

  /** 显示常驻气泡文案：取消瞬态隐藏计时，气泡保持可见直到被取代。 */
  function setBubbleText(text: string): void {
    if (!bubble) return
    clearBubbleHideTimer()
    bubble.textContent = text
    bubble.style.opacity = '1'
  }

  /** 重绘当前阶段文案（阶段推进/瞬态气泡到时回落/拖拽结束后恢复）。 */
  function showStageText(): void {
    if (!stagedState) return
    const key = STAGED_COPY_KEYS[stagedState]?.[stageIndex]
    if (!key) return
    const line = pickLine(activeCopy[key])
    if (line !== undefined) setBubbleText(line)
  }

  /**
   * 瞬态气泡（交互/短状态，spec §3/§4）：立刻换文案并重置隐藏计时（连点可打断）；
   * 到时隐藏——若正处于阶段演进状态则回落到当前阶段文案（交互短暂抢占常驻气泡，过后归还）。
   */
  function showBubble(text: string): void {
    if (!bubble) return
    clearBubbleHideTimer()
    setBubbleText(text)
    bubbleHideTimer = window.setTimeout(() => {
      bubbleHideTimer = undefined
      if (stagedState) showStageText()
      else if (bubble) bubble.style.opacity = '0'
    }, BUBBLE_DISPLAY_MS)
  }

  /** 退出阶段演进状态：取消全部阶段计时并复位标记。 */
  function clearStages(): void {
    for (const t of stageTimers) window.clearTimeout(t)
    stageTimers = []
    stagedState = null
    stageIndex = 0
  }

  /** 进入阶段演进状态：立即显示阶段 0 并按偏移调度后续阶段（spec §3）。 */
  function enterStaged(state: PetState): void {
    clearStages()
    const delays = STAGED_DELAYS[state]
    const keys = STAGED_COPY_KEYS[state]
    if (!delays || !keys || delays.length === 0) return
    stagedState = state
    stageIndex = 0
    showStageText()
    for (let i = 1; i < delays.length; i++) {
      stageTimers.push(window.setTimeout(() => {
        stageIndex = i
        // 拖拽中暂停气泡与动作（spec §4），阶段静默推进、松手后恢复新阶段
        if (!dragging) {
          showStageText()
          playState(state)
        }
      }, delays[i]))
    }
  }

  /** 按 client 坐标应用鼠标跟随（model.focus 吃 canvas 本地坐标）。 */
  function applyFocus(clientX: number, clientY: number): void {
    if (!model || !canvas) return
    const rect = canvas.getBoundingClientRect()
    model.focus(clientX - rect.left, clientY - rect.top)
  }

  /** 解除非 idle 动作期间的 focus 抑制；若有最近指针位置则立即恢复跟随。 */
  function releaseFocusSuppression(): void {
    if (!focusSuppressed) return
    focusSuppressed = false
    if (model && lastPointerClient && !dragging && enabled && !hidden) {
      applyFocus(lastPointerClient.x, lastPointerClient.y)
    }
  }

  /**
   * 取某状态/互动部位的播放候选动作组：
   * - 配置过动画映射 → 随机打乱后逐个尝试（多选=随机选择，不是优先级排序）
   * - 未配置 → 默认候选链（保持旧版有序 fallback）
   */
  function motionNamesFor(slot: AnimationSlot): string[] {
    const configured = motionMap[slot]
    if (configured && configured.length > 0) {
      const names = [...configured]
      for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[names[i], names[j]] = [names[j], names[i]]
      }
      // 配置的动作组全部失败时，仍回退到默认候选，避免模型/配置变化后完全无动作
      const defaults = DEFAULT_MOTION_MAP[slot] ?? []
      for (const name of defaults) {
        if (!names.includes(name)) names.push(name)
      }
      return names
    }
    return DEFAULT_MOTION_MAP[slot] ?? []
  }

  /**
   * 按候选动作链启动动作，统一处理优先级、重播前 stopAllMotions、布尔返回值 fallback。
   * - idle 用 IDLE 优先级；状态/互动用 FORCE（NORMAL 不能打断 NORMAL，无法满足状态立即切换）。
   * - 非 idle 动作启动时抑制 focus，并等 motionFinish 真正播完后再恢复。
   */
  async function startMotionWithPriority(
    names: readonly string[],
    priority: MotionPriority,
    options: { suppressFocus: boolean; isInteraction: boolean },
  ): Promise<boolean> {
    if (!model || names.length === 0) return false
    const seq = ++motionSeq
    const currentModel = model
    previewActive = false
    if (options.suppressFocus) {
      focusSuppressed = true
      currentModel.internalModel?.focusController?.focus(0, 0, true)
    } else {
      releaseFocusSuppression()
    }
    if (options.isInteraction) interactionActive = true
    // 重播同一动作前必须清 MotionState；否则库会因“同 group+index 已激活”拒绝启动。
    currentModel.internalModel?.motionManager?.stopAllMotions?.()
    for (const name of names) {
      if (seq !== motionSeq || !model) return false
      try {
        const ok = await model.motion(name, undefined, priority)
        if (seq !== motionSeq || !model) return false
        if (ok) return true
      } catch {
        if (seq !== motionSeq || !model) return false
        // 单个候选失败/返回 false 时继续尝试下一个
      }
    }
    // 全部候选都失败：清理本次的互动/焦点标记（若期间已被新动作取代则不动）。
    if (seq === motionSeq) {
      if (options.isInteraction) interactionActive = false
      if (options.suppressFocus) releaseFocusSuppression()
    }
    return false
  }

  function playState(state: PetState): void {
    if (!model) return
    const names = motionNamesFor(state)
    if (names.length === 0) return
    // 任何状态动作（含回到 idle）都会取代正在播放的互动/旧状态动作
    interactionGen += 1
    interactionActive = false
    const priority = state === 'idle' ? MotionPriority.IDLE : MotionPriority.FORCE
    void startMotionWithPriority(names, priority, { suppressFocus: state !== 'idle', isInteraction: false })
  }

  /** MotionManager.motionFinish：动作真正播完。互动结束后恢复当前状态动作并解除 focus 抑制。
   * 注意该事件在库内部 state.complete()/自动回 idle 之前同步触发，恢复动作需延到微任务，
   * 避免在 MotionManager.update 中间重入修改 MotionState。 */
  function handleMotionFinish(): void {
    const wasPreview = previewActive
    previewActive = false
    const wasInteraction = interactionActive
    const gen = interactionGen
    const seq = motionSeq
    interactionActive = false
    queueMicrotask(() => {
      // 若期间已有新动作启动（motionSeq 变化），由新动作接管焦点/恢复，这里不再处理
      if (seq !== motionSeq) return
      releaseFocusSuppression()
      // debug 原生预览结束后只恢复 focus，不触发状态动作恢复
      if (wasPreview) return
      if (wasInteraction && gen === interactionGen && !interactionActive && lastState) {
        playState(lastState)
      }
    })
  }

  function applyState(next: PetStateView | null): void {
    const state = demoState ?? next?.state ?? 'idle'
    // 人设热更新（spec §3）：persona 或自定义清单变化时重算台词表；
    // 若正处于长状态，当前阶段气泡立即换新语气重绘（不打断计时节奏）
    const personaId = next?.config.persona || DEFAULT_PERSONA_ID
    if (personaId !== activePersonaId || personaDefsVersion !== next?.version) {
      const customs = next?.customPersonas ?? []
      const changed = personaId !== activePersonaId
        || customs.length !== lastCustomPersonas.length
        || customs.some((p, i) => p !== lastCustomPersonas[i])
      if (changed) {
        lastCustomPersonas = customs
        activePersonaId = personaId
        activeCopy = resolvePersonaCopy(personaId, customs)
        if (stagedState && !dragging) showStageText()
      }
      personaDefsVersion = next?.version ?? -1
    }
    // 状态变化时播状态气泡与状态动作（spec §3）：长状态（思考/等审批）走
    // 阶段演进常驻气泡，短状态气泡瞬态显示；点击互动另走 handleTap（可连点打断）。
    // 动作只在状态变化（及长状态阶段推进）时触发；startMotionWithPriority 会先
    // stopAllMotions 再按优先级启动，保证状态动作可立即切换、阶段可重播。
    if (state !== lastState) {
      lastState = state
      if (STAGED_DELAYS[state]) {
        enterStaged(state)
      } else {
        clearStages()
        const key = TRANSIENT_COPY_KEYS[state]
        const line = key ? pickLine(activeCopy[key]) : undefined
        if (line !== undefined) showBubble(line)
      }
      playState(state)
    }
    if (debugTextEl) {
      debugTextEl.textContent =
        `agent: ${next?.agent ?? '-'}  pet: ${state}  v${next?.version ?? '-'}\n` +
        `persona: ${activePersonaId}  hitAreas: ${hitAreas.join(',') || '-'}\n` +
        `pos: ${Math.round(pos.right)},${Math.round(pos.bottom)}  size: ${pos.size}\n` +
        `bounds: ${Math.round(baseModelW)}x${Math.round(baseModelH)}  canvas: ${canvas?.width ?? 0}x${canvas?.height ?? 0}`
    }
  }

  /** 静态头像降级（WebGL 不可用 / 模型加载失败，spec §7）。 */
  function showFallback(): void {
    if (!box || fallbackShown) return
    fallbackShown = true
    fallbackEl = document.createElement('div')
    fallbackEl.style.cssText = 'pointer-events:auto;width:64px;height:64px;display:flex;align-items:center;justify-content:center;font-size:36px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:16px;color:#fff'
    fallbackEl.textContent = '🐾'
    box.appendChild(fallbackEl)
  }

  /** 移除静态头像占位（模型（重新）加载前调用，避免降级与画布叠加）。 */
  function removeFallback(): void {
    if (fallbackEl && fallbackEl.parentNode) fallbackEl.parentNode.removeChild(fallbackEl)
    fallbackEl = null
    fallbackShown = false
  }

  /**
   * 按“size = canvas 宽度”的规则计算画布尺寸：
   * 模型宽度撑满 size（留 8px 边距），高度按模型原始宽高比自适应。
   */
  function modelCanvasSize(baseW: number, baseH: number, size: number): { width: number; height: number } {
    if (!(baseW > 0 && baseH > 0)) return { width: size, height: Math.round(size * 1.2) }
    const scale = (size - 8) / baseW
    return { width: size, height: Math.max(1, Math.round(baseH * scale + 8)) }
  }

  /** 按当前尺寸重新适配模型（画布已就绪时调用；基准尺寸为 scale=1 时捕获值）。 */
  function fitModel(size: number): void {
    if (!model || !canvas) return
    const w = baseModelW
    const h = baseModelH
    if (w > 0 && h > 0) {
      const s = (size - 8) / w
      model.scale.set(s)
      model.anchor.set(0.5, 0.5)
      model.position.set(canvas.width / 2, canvas.height / 2)
    }
  }

  /** 立即应用画布尺寸（size 视为 canvas 宽度，高度按模型比例自适应）。 */
  function applySizeNow(nextSize: number): void {
    if (canvas && app) {
      const canvasSize = modelCanvasSize(baseModelW, baseModelH, nextSize)
      canvas.width = canvasSize.width
      canvas.height = canvasSize.height
      try { app.renderer.resize(canvasSize.width, canvasSize.height) } catch { /* 旧渲染器 */ }
      if (zoneOverlay) {
        zoneOverlay.width = canvasSize.width
        zoneOverlay.height = canvasSize.height
        zoneOverlay.style.width = `${canvasSize.width}px`
        zoneOverlay.style.height = `${canvasSize.height}px`
      }
      pos.size = nextSize
      syncDebugPanelWidth()
      if (model) fitModel(nextSize)
    } else {
      pos.size = nextSize
    }
  }

  /** 合并同帧/连发的尺寸变更：只落地最后一档（防 SSE 风暴卡死主线程）。 */
  function scheduleSize(nextSize: number): void {
    if (nextSize === pos.size && pendingSize === null) return
    pendingSize = nextSize
    if (sizeRaf) return
    sizeRaf = window.requestAnimationFrame(() => {
      sizeRaf = 0
      const size = pendingSize
      pendingSize = null
      if (size !== null && size !== pos.size) applySizeNow(size)
    })
  }

  /** 销毁当前渲染层（app/canvas/模型引用/静态头像占位）。 */
  function teardownLayer(): void {
    // 作废旧模型的所有动作启动/互动恢复；焦点抑制复位
    motionSeq += 1
    interactionGen += 1
    interactionActive = false
    previewActive = false
    focusSuppressed = false
    lastPointerClient = null
    detachMotionFinish?.()
    detachMotionFinish = null
    if (sizeRaf) { window.cancelAnimationFrame(sizeRaf); sizeRaf = 0 }
    pendingSize = null
    stopZoneLoop()
    if (app) { try { app.destroy(true) } catch { /* 已销毁 */ } }
    app = null
    model = null
    hitAreas = []
    baseModelW = 0
    baseModelH = 0
    if (zoneOverlay && zoneOverlay.parentNode) zoneOverlay.parentNode.removeChild(zoneOverlay)
    zoneOverlay = null
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas)
    canvas = null
    // 气泡临时移回 box，等待下次 petLayer 重建时再挂回
    if (bubble && petLayer && bubble.parentNode === petLayer && box) box.appendChild(bubble)
    if (petLayer && petLayer.parentNode) petLayer.parentNode.removeChild(petLayer)
    petLayer = null
    removeFallback()
  }

  /** 加载/重载模型层：销毁旧层 → 新建画布与 PIXI app → 绑定指针事件。 */
  async function loadModelLayer(url: string | null): Promise<void> {
    teardownLayer()
    if (disposed) return
    if (!url || !box) {
      showFallback()
      return
    }
    try {
      petLayer = document.createElement('div')
      petLayer.style.cssText = 'position:relative;display:inline-block;pointer-events:none'
      canvas = document.createElement('canvas')
      const size = pos.size
      canvas.width = size
      canvas.height = Math.round(size * 1.2)
      canvas.style.cssText = 'pointer-events:auto;display:block'
      zoneOverlay = document.createElement('canvas')
      zoneOverlay.width = canvas.width
      zoneOverlay.height = canvas.height
      zoneOverlay.style.cssText = `position:absolute;left:0;top:0;width:${canvas.width}px;height:${canvas.height}px;pointer-events:none;z-index:2;display:${showSpatialZones ? 'block' : 'none'}`
      petLayer.appendChild(canvas)
      petLayer.appendChild(zoneOverlay)
      // 气泡改为相对 petLayer 定位，避免调试面板插入后把气泡顶到面板上方
      if (bubble && bubble.parentNode !== petLayer) petLayer.appendChild(bubble)
      if (debugEl) {
        petLayer.style.marginTop = '36px'
        syncDebugPanelWidth()
      }
      box.appendChild(petLayer)

      const M = PIXI.live2d?.Live2DModel
      if (!M) throw new Error('Live2DModel 不可用')

      app = new PIXI.Application({
        view: canvas,
        width: canvas.width,
        height: canvas.height,
        backgroundAlpha: 0,
        antialias: false,
        powerPreference: 'low-power',
      })
      try { app.ticker.maxFPS = maxFps } catch { /* 旧 ticker */ }
      pushCleanup(() => { try { app?.destroy(true) } catch { /* 已销毁 */ } })

      const loaded = await M.from(url, { autoInteract: false }) as ModelLike
      if (disposed) {
        // 挂载已拆除（StrictMode/HMR）：弃用本层，不绑定事件
        teardownLayer()
        return
      }
      model = loaded
      // 基础尺寸：优先用模型实际包围盒（getBounds），拿不到再退回 loaded.width/height
      baseModelW = Number(loaded.width) || 0
      baseModelH = Number(loaded.height) || 0
      app.stage.addChild(loaded)
      try {
        const b = loaded.getBounds?.()
        if (b && b.width > 0 && b.height > 0) {
          baseModelW = b.width
          baseModelH = b.height
        }
      } catch { /* 包围盒不可用则保留 loaded.width/height */ }
      hitAreas = Object.keys(loaded.internalModel?.hitAreas ?? {})
      // 根据模型原始宽高自适应 canvas（size 视为 canvas 宽度）
      const canvasSize = modelCanvasSize(baseModelW, baseModelH, pos.size)
      canvas.width = canvasSize.width
      canvas.height = canvasSize.height
      try { app.renderer.resize(canvasSize.width, canvasSize.height) } catch { /* 旧渲染器 */ }
      if (zoneOverlay) {
        zoneOverlay.width = canvasSize.width
        zoneOverlay.height = canvasSize.height
        zoneOverlay.style.width = `${canvasSize.width}px`
        zoneOverlay.style.height = `${canvasSize.height}px`
      }
      syncDebugPanelWidth()
      // 动作真正播完信号：motion() 的 Promise 在开始时即 resolve，不能作为恢复/解除 focus 的时机
      const motionManager = loaded.internalModel?.motionManager
      if (motionManager?.on) {
        motionManager.on('motionFinish', handleMotionFinish)
        detachMotionFinish?.()
        detachMotionFinish = () => motionManager.off?.('motionFinish', handleMotionFinish)
      }
      refreshDebugMotionGroups()
      fitModel(pos.size)
      // 首帧尺寸未知时延迟适配
      if (!(baseModelW > 0 && baseModelH > 0)) {
        try { app.ticker.addOnce(() => fitModel(pos.size)) } catch { /* 首帧适配 */ }
      }
      if (lastState) playState(lastState)
      if (showSpatialZones) startZoneLoop()

      // 指针事件（新 canvas；点击/拖动 6px 阈值）
      canvas.addEventListener('pointerdown', handlePointerDown)
      canvas.addEventListener('pointermove', handlePointerMove)
      canvas.addEventListener('pointerup', handlePointerUp)
      canvas.addEventListener('pointercancel', () => { down = null; dragging = false })
    } catch {
      // 加载失败 → 静态头像（spec §7）；已卸载则不再展示
      teardownLayer()
      if (!disposed) showFallback()
    }
  }

  /** 模型重载队列：串行执行，避免快速切换时并发加载。 */
  let modelLoadQueue: Promise<void> = Promise.resolve()
  function queueModelLoad(url: string | null): void {
    modelLoadQueue = modelLoadQueue.then(() => loadModelLayer(url)).catch(() => {})
  }

  /** 停止空间分区分帧重绘。 */
  function stopZoneLoop(): void {
    if (zoneRaf) { window.cancelAnimationFrame(zoneRaf); zoneRaf = 0 }
  }

  /** 绘制空间回退四档色块（与 spatialTap / classifyTapByPosition 一致）。 */
  function paintSpatialZones(): void {
    if (!showSpatialZones || !zoneOverlay || !canvas || !model) return
    const w = canvas.width
    const h = canvas.height
    if (!(w > 0 && h > 0)) return
    if (zoneOverlay.width !== w) zoneOverlay.width = w
    if (zoneOverlay.height !== h) zoneOverlay.height = h
    zoneOverlay.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px;pointer-events:none;z-index:2;display:block`
    const ctx = zoneOverlay.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    let bounds: { x: number; y: number; width: number; height: number } | null = null
    try {
      const b = model.getBounds?.()
      if (b && b.width > 0 && b.height > 0) bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    } catch { /* 无包围盒 */ }
    if (!bounds) return
    const { x: bx, y: by, width: bw, height: bh } = bounds
    const fill = (color: string, x: number, y: number, rw: number, rh: number, label: string) => {
      if (!(rw > 0 && rh > 0)) return
      ctx.fillStyle = color
      ctx.fillRect(x, y, rw, rh)
      ctx.strokeStyle = 'rgba(255,255,255,.55)'
      ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1)
      ctx.fillStyle = 'rgba(255,255,255,.92)'
      ctx.font = '11px ui-monospace,monospace'
      ctx.fillText(label, x + 4, y + 14)
    }
    const rect = (minNx: number, maxNx: number, minNy: number, maxNy: number) => ({
      x: bx + bw * minNx,
      y: by + bh * minNy,
      w: bw * (maxNx - minNx),
      h: bh * (maxNy - minNy),
    })
    const head = rect(spatialTap.headMinNx, spatialTap.headMaxNx, 0, spatialTap.headMaxNy)
    const body = rect(spatialTap.bodyMinNx, spatialTap.bodyMaxNx, spatialTap.headMaxNy, spatialTap.legMinNy)
    const leg = rect(spatialTap.bodyMinNx, spatialTap.bodyMaxNx, spatialTap.legMinNy, 1)
    const armL = rect(spatialTap.armLeftMinNx, spatialTap.bodyMinNx, spatialTap.armMinNy, spatialTap.legMinNy)
    const armR = rect(spatialTap.bodyMaxNx, spatialTap.armRightMaxNx, spatialTap.armMinNy, spatialTap.legMinNy)
    fill('rgba(80,200,120,.22)', body.x, body.y, body.w, body.h, 'body')
    fill('rgba(80,160,255,.28)', head.x, head.y, head.w, head.h, 'head')
    fill('rgba(255,160,60,.28)', leg.x, leg.y, leg.w, leg.h, 'leg')
    fill('rgba(255,220,60,.32)', armL.x, armL.y, armL.w, armL.h, 'arm')
    fill('rgba(255,220,60,.32)', armR.x, armR.y, armR.w, armR.h, 'arm')
    ctx.strokeStyle = 'rgba(255,80,80,.85)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(bx, by, bw, bh)
  }

  function startZoneLoop(): void {
    stopZoneLoop()
    if (!showSpatialZones) return
    const tick = () => {
      paintSpatialZones()
      zoneRaf = window.requestAnimationFrame(tick)
    }
    zoneRaf = window.requestAnimationFrame(tick)
  }

  function setSpatialZonesVisible(on: boolean): void {
    showSpatialZones = on
    if (zoneOverlay) zoneOverlay.style.display = on ? 'block' : 'none'
    if (on) startZoneLoop()
    else stopZoneLoop()
  }

  /** 调试面板的动画下拉同步（模型加载/切换时刷新选项）。 */
  function updateDebugMotionSelect(): void {
    if (!debugMotionSelect) return
    const previous = debugMotionSelect.value
    debugMotionSelect.textContent = ''
    if (debugMotionList.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '（无动画或模型未加载）'
      debugMotionSelect.appendChild(opt)
      debugMotionSelect.value = ''
      return
    }
    const groups = [...new Set(debugMotionList.map((item) => item.group))]
    for (const group of groups) {
      const optgroup = document.createElement('optgroup')
      optgroup.label = group
      for (const item of debugMotionList) {
        if (item.group !== group) continue
        const opt = document.createElement('option')
        opt.value = `${item.group}\u0000${item.index}`
        opt.textContent = item.label
        optgroup.appendChild(opt)
      }
      debugMotionSelect.appendChild(optgroup)
    }
    if (debugMotionList.some((item) => `${item.group}\u0000${item.index}` === previous)) {
      debugMotionSelect.value = previous
    } else {
      debugMotionSelect.value = ''
    }
  }

  /** 从模型原生 .model3.json 拉取全部具体动画列表（不经过插件状态/映射逻辑）。 */
  async function refreshDebugMotionGroups(): Promise<void> {
    const url = currentModelUrl
    const currentModel = model
    if (!url || !currentModel) return
    const cached = motionListCache.get(url)
    if (cached) {
      if (model === currentModel && debugMotionSelect) {
        debugMotionList = cached
        updateDebugMotionSelect()
      }
      return
    }
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as {
        FileReferences?: { Motions?: Record<string, Array<{ File?: unknown } | unknown>> }
        Motions?: Record<string, Array<{ File?: unknown } | unknown>>
      }
      const motions = data?.FileReferences?.Motions ?? data?.Motions ?? {}
      const list: DebugMotionItem[] = []
      for (const [group, items] of Object.entries(motions)) {
        if (!Array.isArray(items)) continue
        items.forEach((motion, index) => {
          const file = typeof motion === 'object' && motion !== null && 'File' in motion
            ? String((motion as { File?: unknown }).File ?? index)
            : String(index)
          list.push({ group, index, label: `${group} / ${file}` })
        })
      }
      motionListCache.set(url, list)
      // 防止异步返回时模型/面板已经切换
      if (model !== currentModel || !debugMotionSelect) return
      debugMotionList = list
      updateDebugMotionSelect()
    } catch {
      // 原生 JSON 拉取失败时，退回到运行时 definitions（至少还能看到列表）
      const defs = currentModel.internalModel?.motionManager?.definitions ?? {}
      const list: DebugMotionItem[] = []
      for (const [group, motions] of Object.entries(defs)) {
        if (!Array.isArray(motions)) continue
        motions.forEach((motion, index) => {
          const file = typeof motion === 'object' && motion !== null && 'File' in motion
            ? String((motion as { File?: unknown }).File ?? index)
            : String(index)
          list.push({ group, index, label: `${group} / ${file}` })
        })
      }
      if (model !== currentModel || !debugMotionSelect) return
      debugMotionList = list
      updateDebugMotionSelect()
    }
  }

  /** debug 预览：直接播放模型原生指定动画（动作组 + 下标）。
   *  每次点击都 stopAllMotions 后重播，因此同一动画也可反复预览；
   *  预览期间抑制 focus，播完只恢复跟随，不触发状态动作恢复。 */
  function previewMotion(value: string): void {
    if (!model || !value) return
    const sep = value.indexOf('\u0000')
    if (sep < 0) return
    const group = value.slice(0, sep)
    const index = Number(value.slice(sep + 1))
    if (!Number.isInteger(index)) return
    const currentModel = model
    ++motionSeq // 作废旧预览/动作的异步回调，避免旧 motionFinish 释放新预览的焦点
    previewActive = true
    focusSuppressed = true
    currentModel.internalModel?.focusController?.focus(0, 0, true)
    currentModel.internalModel?.motionManager?.stopAllMotions?.()
    void currentModel.motion(group, index, MotionPriority.FORCE)
  }

  /** 让调试面板宽度与 canvas 同宽（canvas 尺寸变化/模型加载时同步）。 */
  function syncDebugPanelWidth(): void {
    if (!debugEl) return
    const w = canvas?.width ?? pos.size
    debugEl.style.width = `${w}px`
    debugEl.style.boxSizing = 'border-box'
  }

  /** 调试面板动态开关（spec §2）。 */
  function ensureDebugPanel(show: boolean): void {
    if (show && !debugEl && box) {
      debugEl = document.createElement('div')
      debugEl.style.cssText = 'pointer-events:auto;margin:6px 0 10px;padding:10px 12px;background:rgba(24,26,36,.94);color:#e8eaf0;border:1px solid rgba(128,128,128,.22);border-radius:10px;font:12px/1.5 ui-monospace,monospace;box-shadow:0 4px 16px rgba(0,0,0,.35)'

      const debugTitle = document.createElement('div')
      debugTitle.style.cssText = 'font-size:12px;font-weight:600;color:#aeb8cc;letter-spacing:.3px;margin-bottom:2px'
      debugTitle.textContent = '调试面板'
      debugEl.appendChild(debugTitle)

      const sectionLabel = (text: string): HTMLDivElement => {
        const el = document.createElement('div')
        el.style.cssText = 'margin:10px 0 4px;color:#7f8aa0;font-size:11px;font-weight:600;letter-spacing:.3px'
        el.textContent = text
        return el
      }

      // 状态演示：等宽按钮网格
      const demoLabel = sectionLabel('状态演示')
      debugEl.appendChild(demoLabel)
      const demoRow = document.createElement('div')
      demoRow.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:4px'
      for (const st of ['idle', 'thinking', 'waiting', 'done', 'error'] as const) {
        const btn = document.createElement('button')
        btn.textContent = st
        btn.style.cssText = 'padding:4px 0;border-radius:6px;border:1px solid rgba(128,128,128,.25);background:rgba(128,128,128,.1);color:#dbe2ef;font-size:11px;font-family:inherit;cursor:pointer;outline:none'
        btn.onmouseenter = () => { btn.style.background = 'rgba(120,170,255,.22)' }
        btn.onmouseleave = () => { btn.style.background = 'rgba(128,128,128,.1)' }
        btn.onclick = () => { demoState = demoState === st ? null : st; applyState(view) }
        demoRow.appendChild(btn)
      }
      debugEl.appendChild(demoRow)

      // 动画预览：原生动画下拉 + 播放按钮
      const motionLabel = sectionLabel('动画预览')
      debugEl.appendChild(motionLabel)
      const motionSelect = document.createElement('select')
      motionSelect.style.cssText = 'flex:1;min-width:0;background:#1c1e28;color:#e8eaf0;border:1px solid rgba(128,128,128,.3);border-radius:6px;font-size:12px;padding:4px 6px;outline:none'
      motionSelect.onchange = () => previewMotion(motionSelect.value)
      const motionPlay = document.createElement('button')
      motionPlay.textContent = '播放'
      motionPlay.style.cssText = 'padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;background:rgba(120,170,255,.28);color:#e8eaf0;border:1px solid rgba(120,170,255,.35);outline:none'
      motionPlay.onmouseenter = () => { motionPlay.style.background = 'rgba(120,170,255,.4)' }
      motionPlay.onmouseleave = () => { motionPlay.style.background = 'rgba(120,170,255,.28)' }
      motionPlay.onclick = () => previewMotion(motionSelect.value)
      const motionRow = document.createElement('div')
      motionRow.style.cssText = 'display:flex;gap:6px;align-items:center'
      motionRow.appendChild(motionSelect)
      motionRow.appendChild(motionPlay)
      debugMotionSelect = motionSelect
      debugEl.appendChild(motionRow)

      // 状态信息：与上方区域分隔
      debugTextEl = document.createElement('div')
      debugTextEl.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(128,128,128,.18);color:#9aa5b8;font-size:11px;white-space:pre-wrap;word-break:break-all'
      debugEl.appendChild(debugTextEl)
      syncDebugPanelWidth()
      refreshDebugMotionGroups()
      // 调试面板放在 petLayer 之前：显示在 canvas 上方；气泡在 petLayer 上方，
      // 通过 petLayer margin-top 把气泡空间让出来，使顺序为 调试面板 → 气泡 → canvas
      if (petLayer) {
        box.insertBefore(debugEl, petLayer)
        petLayer.style.marginTop = '36px'
      } else {
        box.appendChild(debugEl)
      }
      applyState(view)
    } else if (!show && debugEl) {
      previewActive = false
      focusSuppressed = false
      debugEl.parentNode?.removeChild(debugEl)
      debugEl = null
      debugMotionSelect = null
      debugTextEl = null
      if (petLayer) petLayer.style.marginTop = ''
    }
  }

  /** 运行时应用配置变化（spec §2/§6/§7）：开关 / 尺寸 / 帧率 / 调试 / 分区 / 模型。 */
  function applyConfig(next: PetStateView): void {
    const cfg = next.config
    // 开关：显示/隐藏 + 暂停/恢复渲染循环（syncTicker 合并隐藏/失焦状态，spec §7）
    if (box) box.style.display = cfg.enabled ? '' : 'none'
    enabled = cfg.enabled
    syncTicker()
    // 调试面板 + 点击分区（开发者选项，互不强制绑定）
    ensureDebugPanel(cfg.debug)
    setSpatialZonesVisible(!!cfg.showTapZones)
    // 空间回退阈值：随当前模型解析结果热更新（自定义可覆盖；色块与分档共用）
    if (cfg.spatialTap) spatialTap = { ...cfg.spatialTap }
    // 动画映射：随当前模型解析结果热更新（自定义/内置可覆盖；缺省默认）
    if (cfg.motionMap) motionMap = { ...DEFAULT_MOTION_MAP, ...cfg.motionMap }
    // 帧率：立刻改 ticker.maxFPS（0 = 不限制）
    applyMaxFps(cfg.maxFps)
    // 尺寸：合并后重设画布 + 模型适配（避免连发 SSE 同步卡死主线程）
    const nextSize = cfg.size
    if (nextSize !== pos.size) scheduleSize(nextSize)
    // 模型：modelUrl 变化 → 重载
    const nextUrl = cfg.modelUrl || null
    if (nextUrl !== currentModelUrl) {
      currentModelUrl = nextUrl
      queueModelLoad(nextUrl)
    }
  }

  // ---- 指针：点击/拖动判定（6px 阈值，spec §4） ----
  let down: { x: number; y: number; startRight: number; startBottom: number } | null = null
  let dragging = false

  function handlePointerDown(e: PointerEvent): void {
    down = { x: e.clientX, y: e.clientY, startRight: pos.right, startBottom: pos.bottom }
    dragging = false
    canvas?.setPointerCapture(e.pointerId)
  }
  function handlePointerMove(e: PointerEvent): void {
    if (!down) return
    const dx = e.clientX - down.x
    const dy = e.clientY - down.y
    if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      dragging = true
      if (bubble) bubble.style.opacity = '0'
    }
    if (dragging && box) {
      pos.right = Math.max(0, down.startRight - dx)
      pos.bottom = Math.max(0, down.startBottom - dy)
      box.style.right = `${Math.round(pos.right)}px`
      box.style.bottom = `${Math.round(pos.bottom)}px`
    }
  }
  function handlePointerUp(e: PointerEvent): void {
    if (!down) return
    if (dragging) {
      api.setDisplay({ right: Math.round(pos.right), bottom: Math.round(pos.bottom) }).catch(() => {})
      // 拖拽中隐藏的常驻气泡恢复当前阶段文案（spec §4：拖拽中暂停、结束恢复）
      showStageText()
    } else {
      handleTap(e)
    }
    down = null
    dragging = false
  }

  // ---- 鼠标跟随（spec §4）：全局 pointermove，头/眼/身体看向鼠标 ----
  function handleGlobalPointerMove(e: PointerEvent): void {
    lastPointerClient = { x: e.clientX, y: e.clientY }
    // 非 idle 动作播放期间抑制 focus，避免动作关键帧被鼠标跟随叠加（spec §4）
    if (!model || !canvas || dragging || !enabled || hidden || focusSuppressed) return
    applyFocus(e.clientX, e.clientY)
  }
  function handleGlobalMouseOut(e: MouseEvent): void {
    // 仅当真正离开页面/窗口时复位；元素间移动会冒泡 mouseout，需排除 relatedTarget 非空
    if (e.relatedTarget) return
    lastPointerClient = null
    if (!model || dragging || !enabled || hidden) return
    // 非 idle 动作期间 focus 已被归零并抑制，不需要额外复位
    if (!focusSuppressed) {
      // 复位正视前方：FocusController 吃 [-1,1] 归一化目标，直接归零
      model.internalModel?.focusController?.focus(0, 0, true)
    }
  }

  function handleTap(e: PointerEvent): void {
    if (!canvas || !model) return
    const now = Date.now()
    if (now - lastTapAt < TAP_DEBOUNCE_MS) return
    lastTapAt = now
    try {
      const rect = canvas.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      // hitTest(x, y) 吃画布世界坐标（库内部做模型空间转换），返回命中的区域名数组
      const hits = model.hitTest(localX, localY)
      let bounds: { x: number; y: number; width: number; height: number } | null = null
      try {
        const b = model.getBounds?.()
        if (b && b.width > 0 && b.height > 0) bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
      } catch { /* 无包围盒则仅按命中名 */ }
      const part = classifyTap(hits, localX, localY, hitAreas, bounds, spatialTap)
      if (part === null) return
      const poolKey = `tap${part[0].toUpperCase()}${part.slice(1)}` as 'tapHead' | 'tapLeg' | 'tapArm' | 'tapBody'
      const line = pickLine(activeCopy[poolKey], lastTapLine[poolKey])
      if (line !== undefined) {
        lastTapLine[poolKey] = line
        showBubble(line)
      }
      void playInteractionMotion(motionNamesFor(part))
    } catch {
      // 命中检测异常：忽略本次点击
    }
  }

  /**
   * 播放互动动作（摸头/点身体）：FORCE 可打断状态动画与上一次互动；动作真正播完
   * （motionFinish）后恢复当前状态动画（spec §4）。motion() 的 Promise 只代表开始，
   * 因此不再用 Promise 完成时间或 3s 兜底来恢复。
   */
  async function playInteractionMotion(names: readonly string[]): Promise<void> {
    if (!model || names.length === 0) return
    ++interactionGen
    await startMotionWithPriority(
      names,
      MotionPriority.FORCE,
      { suppressFocus: true, isInteraction: true },
    )
  }

  // ---- 主流程 ----
  void (async () => {
    try {
      // 1. 初始状态（配置 + 显示位置）
      try { view = await api.state() } catch { /* 首帧前 API 不可用则用默认 */ }
      if (disposed) return
      if (view) pos = { ...view.display, size: view.config.size }

      // 2. 顶层容器（Popover API，回退 body + max z）
      box = document.createElement('div')
      const popoverSupported = typeof box.showPopover === 'function'
      // UA 对 [popover] 默认 inset:0 + margin:auto（居中）、border:solid + Canvas 背景，
      // 必须显式重置（ADR-005 实证：居中 + 边框/背景两处坑）
      box.style.cssText = `position:fixed;inset:auto;top:auto;left:auto;right:${pos.right}px;bottom:${pos.bottom}px;margin:0;padding:0;border:none;background:transparent;width:auto;height:auto;overflow:visible;pointer-events:none${popoverSupported ? '' : ';z-index:2147483647'}`
      if (popoverSupported) box.setAttribute('popover', 'manual')
      document.body.appendChild(box)
      if (popoverSupported) { try { box.showPopover() } catch { /* 已显示 */ } }
      pushCleanup(() => { box?.parentNode?.removeChild(box) })

      // 气泡层
      bubble = document.createElement('div')
      bubble.style.cssText = 'position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:8px;padding:4px 10px;background:rgba(255,255,255,.95);color:#222;border-radius:999px;font:12px/1.5 sans-serif;white-space:nowrap;opacity:0;transition:opacity .2s;pointer-events:none'
      box.appendChild(bubble)

      // 3. vendor 脚本（Host 同源）
      for (const src of VENDOR_SCRIPTS) {
        await loadScript(src)
        if (disposed) return
      }

      // 4. 初始模型（config.modelUrl：Host 解析后的 .model3.json URL，spec §6）
      const initialUrl = view?.config.modelUrl || null
      currentModelUrl = initialUrl
      await loadModelLayer(initialUrl)
      if (disposed) return

      // 4.1 全局鼠标跟随（spec §4）：页面任意位置移动→头/眼/身体看向鼠标；
      //     鼠标移出页面→复位正视前方。监听挂在 document 上，模型重载时无需重绑。
      const onGlobalPointerMove = handleGlobalPointerMove
      const onGlobalMouseOut = handleGlobalMouseOut
      document.addEventListener('pointermove', onGlobalPointerMove, { passive: true })
      document.addEventListener('mouseout', onGlobalMouseOut)
      pushCleanup(() => {
        document.removeEventListener('pointermove', onGlobalPointerMove)
        document.removeEventListener('mouseout', onGlobalMouseOut)
      })

      // 5. 状态订阅（SSE 推送，ADR-006）：替代 v0.1 的 800ms 轮询。
      //    断线由 EventSource 自动重连，重连后首帧即全量快照，无需补偿拉取。
      const handleState = (next: PetStateView): void => {
        if (disposed) return
        view = next
        // 位置取持久化值；渲染尺寸保持现状，由 applyConfig 负责 diff 与更新
        pos = { right: next.display.right, bottom: next.display.bottom, size: pos.size }
        applyConfig(next)
        applyState(next)
      }
      let closeEvents: (() => void) | undefined
      try {
        closeEvents = api.events(handleState, () => { /* 断线重连中，EventSource 自动重试 */ })
      } catch {
        // EventSource 不可用：保留首帧快照（静态宠物），不再更新
      }
      // 标签页隐藏/窗口失焦 → 暂停渲染循环；恢复时继续（spec §7）
      const onVisibility = () => { hidden = document.visibilityState !== 'visible'; syncTicker() }
      const onBlur = () => { hidden = true; syncTicker() }
      const onFocus = () => { hidden = false; syncTicker() }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('blur', onBlur)
      window.addEventListener('focus', onFocus)
      pushCleanup(() => {
        closeEvents?.()
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('focus', onFocus)
      })

      // 6. 初始应用（含开关/尺寸/调试/模型；SSE 首帧到达前先用已拉到的快照）
      if (view) {
        applyConfig(view)
        applyState(view)
      }
    } catch (error) {
      // 静态头像降级（WebGL 不可用 / 模型加载失败，spec §7）
      showFallback()
    }
  })()

  return () => { for (const fn of cleanup) { try { fn() } catch { /* 忽略清理错误 */ } } }
}

/** 插件入口。 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots') as SlotsLike | undefined
  if (slots === undefined) return
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'live2d-pet' },
    () => createElement(PetAnchor),
  ))

  // 「自定义人设 ↗」直达打开（spec §2）：曾优先经 DSH workspaces.openPath 用系统
  // 默认程序打开人设文件；DSH 0.1.5 起 IWorkspaces 已移除 openPath（能力未提供时
  // 结构探测返回 false），由设置页弹层兜底（复制路径/模板）。
  const openPath = async (path: string): Promise<boolean> => {
    try {
      const workspaces = ctx.get('workspaces') as { openPath?: (p: string) => Promise<void> } | undefined
      if (!workspaces?.openPath) return false
      await workspaces.openPath(path)
      return true
    } catch {
      return false
    }
  }

  // 桌宠配置设置页（settings.section，spec §2）：开关/尺寸/人设/模型列表/调试，
  // 读写经插件自身 API（/api/live2d-pet/settings，Host 直连 ctx.settings；
  // 不走 settingsScope wire，见 docs/research/settings-tab.md「设置服务不可用」根因）。
  // 桌宠配置设置页（settings.section，spec §2）：开关/尺寸/人设/模型列表/调试，
  // 读写经插件自身 API（/api/live2d-pet/settings，Host 直连 ctx.settings；
  // 不走 settingsScope wire，见 docs/research/settings-tab.md「设置服务不可用」根因）。
  // 导航爪印：平台 settings-general 按 id 硬编码图标（未知 id→齿轮），故 register.icon
  // 暂不生效；installPetSettingsNavIcon 在 DOM 层替换，卸载时一并清理。
  slots.inject('settings.section', () => {
    const stopNavIcon = installPetSettingsNavIcon()
    const disposeSection = slots.register(
      {
        name: 'settings.section',
        id: 'live2d-pet',
        order: 200,
        label: () => '桌宠配置',
        icon: pawNavIcon,
      },
      () => createElement(PetSettingsSection, { openPath }),
    )
    return () => {
      stopNavIcon()
      disposeSection()
    }
  })
}
