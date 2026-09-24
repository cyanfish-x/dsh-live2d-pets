/**
 * PetService：宠物状态机 + 显示配置 + 持久化。
 * 状态源为 DSH 真实事件（Event.listEvents 实测）：
 *   agent/status（idle⇄running）、agent/error、agent/turn-stopping、approval/request、
 *   session/event 总线上的 deliverables/presented（交付庆祝，ADR-012）。
 * 配置经 getConfig() 读取 settings 解析值（schema 默认 → base → 用户层）。
 * @module dsh-live2d-pets/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Config } from './index.ts'
import type { CustomModelEntry, MotionMap, SpatialTapConfig } from './models.ts'
import { resolveModelUrl, resolveMotionMap, resolveSpatialTap } from './models-host.ts'
import { CustomModelsStore, type CustomModelsFileView } from './custom-models.ts'
import {
  loadPetPersist,
  savePetPersist,
  normalizeDisplay,
  DEFAULT_DISPLAY,
  type PetDisplay,
} from './persist.ts'
import { PersonasStore, type PersonasFileView } from './personas.ts'
import { DEFAULT_PERSONA_ID, type CustomPersonaDef } from './persona-shared.ts'

export type PetState = 'idle' | 'thinking' | 'error' | 'done' | 'waiting' | 'delivered'

export interface PetStateView {
  state: PetState
  agent: string
  config: {
    enabled: boolean
    size: number
    /** 渲染帧率上限（30 / 60 / 0=不限制；spec §2/§7）。 */
    maxFps: number
    model: string
    /** 解析后的 .model3.json URL（模型 id → URL，spec §6）。 */
    modelUrl: string | null
    debug: boolean
    /** 显示点击分区叠加层（空间回退色块）。 */
    showTapZones: boolean
    /** 当前模型生效的空间回退完整阈值（自定义可覆盖；spec §4）。 */
    spatialTap: SpatialTapConfig
    /** 当前模型生效的状态/互动动画映射（自定义/内置可覆盖；缺省 DEFAULT_MOTION_MAP）。 */
    motionMap: MotionMap
    /** 选中人设 id（内置或自定义；spec §3）。 */
    persona: string
  }
  display: PetDisplay
  /** 自定义人设原样定义（client 端与内置文案合并出完整台词池）。 */
  customPersonas: CustomPersonaDef[]
  /** 人设文件级/条目级问题（设置页内联提示；null 无异常）。 */
  personasError: string | null
  /** 人设文件绝对路径（「自定义人设 ↗」openPath / 复制路径用）。 */
  personasFile: string
  version: number
}

/** "完成/交付"庆祝状态在回到空闲前的保持时长（ms）。 */
const DONE_HOLD_MS = 3500

/** 变化通知监听器（状态/显示/配置变化时触发，供 SSE 推送使用）。 */
type ChangeListener = () => void

export class PetService {
  private state: PetState = 'idle'
  private agent = 'idle'
  private version = 0
  private display: PetDisplay
  private holdTimerId: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<ChangeListener>()

  constructor(
    private readonly ctx: Context,
    private readonly getConfig: () => Config,
    private readonly personasStore?: PersonasStore,
    private readonly customModelsStore?: CustomModelsStore,
  ) {
    this.display = loadPetPersist()
    // 卸载时清理"完成/交付"保持计时器
    ctx.effect(() => () => {
      if (this.holdTimerId) clearTimeout(this.holdTimerId)
    })

    ctx.on('agent/status', (payload) => {
      const status = payload?.status
      if (!status) return
      this.agent = String(status)
      if (status === 'running') {
        this.set('thinking')
      } else if (status === 'idle' && this.state !== 'done' && this.state !== 'delivered') {
        // done/delivered 保持期内到达的 idle 不打断庆祝（由保持计时器负责回收）
        this.set('idle')
      }
    })
    ctx.on('agent/error', () => this.set('error'))
    ctx.on('agent/turn-stopping', () => {
      // 交付保持期内紧随的轮次结束不打断交付庆祝（交付是更强的完成时刻，ADR-012）
      if (this.state !== 'delivered') this.setDone()
    })
    // approval/request 是 waterfall 事件：必须调用 next() 放行审批链
    ctx.on('approval/request', (_req, next) => {
      this.set('waiting')
      return next()
    })
    // 模型经 present 工具交付文件（会话事件总线，ADR-012）
    ctx.on('session/event', (_session, event) => {
      if (event?.type === 'deliverables/presented') this.setDelivered()
    })
  }

  /** 立即切换状态；取消未完成的"完成/交付"保持计时。 */
  private set(next: PetState): void {
    if (this.holdTimerId) {
      clearTimeout(this.holdTimerId)
      this.holdTimerId = undefined
    }
    if (this.state === next) return
    this.state = next
    this.version += 1
    this.emitChange()
  }

  /** 进入庆祝态（done/delivered）并保持 DONE_HOLD_MS 后回空闲（客户端据此播庆祝动画）。 */
  private setHeld(state: 'done' | 'delivered'): void {
    this.set(state)
    this.holdTimerId = setTimeout(() => {
      this.holdTimerId = undefined
      this.set('idle')
    }, DONE_HOLD_MS)
  }

  private setDone(): void {
    this.setHeld('done')
  }

  private setDelivered(): void {
    this.setHeld('delivered')
  }

  /** 浏览器轮询用的状态快照（配置实时读取 settings 解析值；人设文件每次现读，spec §2）。 */
  snapshot(): PetStateView {
    const config = this.getConfig()
    // 无缓存现读：改完文件刷新页面/点「重新读取」即拿到最新（spec §2）
    const personas: PersonasFileView = this.personasStore?.load()
      ?? { personas: [], error: null, path: '' }
    const customModels = this.listCustomModels()
    return {
      state: this.state,
      agent: this.agent,
      config: {
        enabled: config.enabled,
        size: config.size,
        maxFps: config.maxFps,
        model: config.model,
        modelUrl: resolveModelUrl(config.model, customModels),
        debug: config.debug,
        showTapZones: !!config.showTapZones,
        spatialTap: resolveSpatialTap(config.model, customModels),
        motionMap: resolveMotionMap(config.model, customModels),
        persona: config.persona || DEFAULT_PERSONA_ID,
      },
      display: { ...this.display },
      customPersonas: personas.personas,
      personasError: personas.error,
      personasFile: personas.path,
      version: this.version,
    }
  }

  /** 重新读取人设文件并推送（设置页「↻ 重新读取」按钮；version 递增触发客户端感知）。 */
  reloadPersonas(): PersonasFileView {
    const view = this.personasStore?.load() ?? { personas: [], error: null, path: '' }
    this.version += 1
    this.emitChange()
    return view
  }

  /** 用户自定义模型列表（设置面板模型列表的 custom 部分，Host 权威视图）。 */
  listCustomModels(): CustomModelEntry[] {
    return this.customModelsStore?.load().models ?? this.getConfig().customModels ?? []
  }

  /** 自定义模型文件视图（路径/错误/列表），供设置面板与“打开配置文件”使用。 */
  customModelsFile(): CustomModelsFileView {
    return this.customModelsStore?.load() ?? { models: [], error: null, path: '' }
  }

  /** 写回自定义模型列表（设置面板保存后调用），并推送配置变化。 */
  saveCustomModels(models: CustomModelEntry[]): CustomModelsFileView {
    const view = this.customModelsStore?.write(models) ?? { models, error: null, path: '' }
    this.version += 1
    this.emitChange()
    return view
  }

  /** 更新显示配置（拖动/尺寸）并持久化；数值在服务端按权威边界 clamp。 */
  setDisplay(patch: Partial<PetDisplay>): PetDisplay {
    this.display = normalizeDisplay({
      right: patch.right ?? this.display.right,
      bottom: patch.bottom ?? this.display.bottom,
      size: patch.size ?? this.display.size,
    })
    savePetPersist(this.display)
    this.version += 1
    this.emitChange()
    return { ...this.display }
  }

  /** 重置为默认显示配置（调试用）。 */
  resetDisplay(): PetDisplay {
    this.display = { ...DEFAULT_DISPLAY }
    savePetPersist(this.display)
    this.version += 1
    this.emitChange()
    return { ...this.display }
  }

  /** 订阅变化推送（状态/显示变化自动触发）；返回退订函数。 */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 配置（settings 解析值）变化后由外部调用，触发一次推送（ADR-006）。 */
  notifyConfigChanged(): void {
    this.emitChange()
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener()
  }
}
