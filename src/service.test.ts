import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { PetService } from './service.ts'
import type { Config } from './index.ts'

const BASE_CONFIG: Config = { enabled: true, size: 160, maxFps: 30, model: 'hiyori', developerMode: false, debug: false, showTapZones: false, customModels: [], persona: 'tsundere' }

function makeHarness(overrides: Partial<Config> = {}) {
  const handlers = new Map<string, Array<(payload?: unknown, next?: () => void) => unknown>>()
  const effects: Array<() => void> = []
  const ctx = {
    on: (event: string, fn: (payload?: unknown, next?: () => void) => unknown) => {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    effect: (fn: () => () => void) => { effects.push(fn()) },
  } as unknown as Context
  const emit = (event: string, payload?: unknown) => {
    const next = vi.fn()
    for (const fn of handlers.get(event) ?? []) fn(payload, next)
    return next
  }
  // 双参事件（如 session/event 的 (session, event) 载荷）
  const emitArgs = (event: string, ...args: unknown[]) => {
    for (const fn of handlers.get(event) ?? []) (fn as (...a: unknown[]) => unknown)(...args)
  }
  const config = { ...BASE_CONFIG, ...overrides }
  const service = new PetService(ctx, () => config)
  return { service, emit, emitArgs, dispose: () => { for (const fn of effects) fn() } }
}

beforeEach(() => {
  // 隔离持久化：避免读到真实 $DSH_HOME 下的 live2d-pet.json
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-live2d-pet-svc-'))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(process.env.DSH_HOME!, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('PetService 状态机', () => {
  it('初始为 idle，agent=idle，version 0', () => {
    const { service } = makeHarness()
    const view = service.snapshot()
    expect(view.state).toBe('idle')
    expect(view.agent).toBe('idle')
    expect(view.version).toBe(0)
    expect(view.config.maxFps).toBe(30)
    expect(view.config.spatialTap).toEqual({
      headMaxNy: 0.30,
      legMinNy: 0.57,
      armMinNy: 0.28,
      headMinNx: 0.32,
      headMaxNx: 0.68,
      bodyMinNx: 0.36,
      bodyMaxNx: 0.64,
      armLeftMinNx: 0.18,
      armRightMaxNx: 0.82,
    })
    expect(view.config.motionMap.idle).toEqual(['Idle'])
    expect(view.config.motionMap.thinking).toEqual(['Thinking', 'Working', 'Idle'])
  })

  it('agent running → thinking，idle → idle', () => {
    const { service, emit } = makeHarness()
    emit('agent/status', { status: 'running' })
    expect(service.snapshot().state).toBe('thinking')
    emit('agent/status', { status: 'idle' })
    expect(service.snapshot().state).toBe('idle')
  })

  it('agent/error → error', () => {
    const { service, emit } = makeHarness()
    emit('agent/error', {})
    expect(service.snapshot().state).toBe('error')
  })

  it('approval/request → waiting，且必须放行审批链', () => {
    const { service, emit } = makeHarness()
    const next = emit('approval/request', {})
    expect(service.snapshot().state).toBe('waiting')
    expect(next).toHaveBeenCalled()
  })

  it('turn-stopping → done；保持期内 idle 不打断，3.5s 后回 idle', () => {
    const { service, emit } = makeHarness()
    emit('agent/turn-stopping', {})
    expect(service.snapshot().state).toBe('done')
    emit('agent/status', { status: 'idle' })
    expect(service.snapshot().state).toBe('done')
    vi.advanceTimersByTime(3500)
    expect(service.snapshot().state).toBe('idle')
  })

  it('done 保持期内 running → thinking 并取消保持计时', () => {
    const { service, emit } = makeHarness()
    emit('agent/turn-stopping', {})
    emit('agent/status', { status: 'running' })
    expect(service.snapshot().state).toBe('thinking')
    vi.advanceTimersByTime(3500)
    expect(service.snapshot().state).toBe('thinking')
  })
  it('deliverables/presented → delivered；保持期内 idle/turn-stopping 不打断，3.5s 后回 idle', () => {
    const { service, emit, emitArgs } = makeHarness()
    emitArgs('session/event', {}, { type: 'deliverables/presented' })
    expect(service.snapshot().state).toBe('delivered')
    emit('agent/status', { status: 'idle' })
    emit('agent/turn-stopping', {})
    expect(service.snapshot().state).toBe('delivered')
    vi.advanceTimersByTime(3500)
    expect(service.snapshot().state).toBe('idle')
  })
  it('无关 session/event 不触发交付态', () => {
    const { service, emitArgs } = makeHarness()
    emitArgs('session/event', {}, { type: 'turn/message' })
    expect(service.snapshot().state).toBe('idle')
  })
  it('done 保持期内交付升级为 delivered；thinking 仍即时打断', () => {
    const { service, emit, emitArgs } = makeHarness()
    emit('agent/turn-stopping', {})
    expect(service.snapshot().state).toBe('done')
    emitArgs('session/event', {}, { type: 'deliverables/presented' })
    expect(service.snapshot().state).toBe('delivered')
    emit('agent/status', { status: 'running' })
    expect(service.snapshot().state).toBe('thinking')
    vi.advanceTimersByTime(3500)
    expect(service.snapshot().state).toBe('thinking')
  })

  it('状态变化递增 version', () => {
    const { service, emit } = makeHarness()
    const v0 = service.snapshot().version
    emit('agent/status', { status: 'running' })
    expect(service.snapshot().version).toBe(v0 + 1)
  })

  it('卸载时清理 done 保持计时器', () => {
    const { service, emit, dispose } = makeHarness()
    emit('agent/turn-stopping', {})
    dispose()
    vi.advanceTimersByTime(3500)
    // 计时器已清理，状态应保持在 done（不再被回收）
    expect(service.snapshot().state).toBe('done')
  })
})

describe('PetService 显示配置', () => {
  it('setDisplay 按权威边界 clamp 越界数值', () => {
    const { service } = makeHarness()
    const d = service.setDisplay({ size: 9999, right: -50, bottom: 1e6 })
    expect(d.size).toBe(400)
    expect(d.right).toBe(0)
    expect(d.bottom).toBe(4000)
  })

  it('setDisplay 只更新给定字段并递增 version', () => {
    const { service } = makeHarness()
    const v0 = service.snapshot().version
    const d = service.setDisplay({ size: 200 })
    expect(d).toEqual({ right: 24, bottom: 20, size: 200 })
    expect(service.snapshot().version).toBe(v0 + 1)
  })

  it('resetDisplay 回到默认', () => {
    const { service } = makeHarness()
    service.setDisplay({ size: 300 })
    expect(service.resetDisplay()).toEqual({ right: 24, bottom: 20, size: 160 })
  })

  it('snapshot 解析模型 URL：preset id / 自定义 id / 未命中 null', () => {
    const { service } = makeHarness({
      model: 'custom-a',
      customModels: [{ id: 'custom-a', name: 'A', modelUrl: 'https://example.com/a.model3.json' }],
    })
    expect(service.snapshot().config.modelUrl).toBe('https://example.com/a.model3.json')
    expect(makeHarness({ model: 'hiyori' }).service.snapshot().config.modelUrl).toMatch(/^https:\/\//)
    expect(makeHarness({ model: 'missing' }).service.snapshot().config.modelUrl).toBeNull()
  })

  it('snapshot.spatialTap：自定义覆盖合并，内置用默认', () => {
    const { service } = makeHarness({
      model: 'custom-a',
      customModels: [{
        id: 'custom-a',
        name: 'A',
        modelUrl: 'https://example.com/a.model3.json',
        spatialTap: { headMaxNy: 0.45 },
      }],
    })
    expect(service.snapshot().config.spatialTap.headMaxNy).toBe(0.45)
    expect(service.snapshot().config.spatialTap.legMinNy).toBe(0.58)
    expect(makeHarness({ model: 'hiyori' }).service.snapshot().config.spatialTap.headMaxNy).toBe(0.30)
    expect(makeHarness({ model: 'mao' }).service.snapshot().config.spatialTap.headMinNx).toBe(0)
  })

  it('listCustomModels 返回配置中的自定义清单', () => {
    const { service } = makeHarness({ customModels: [{ id: 'x', name: 'X', modelUrl: 'https://x/m3.json' }] })
    expect(service.listCustomModels()).toEqual([{ id: 'x', name: 'X', modelUrl: 'https://x/m3.json' }])
  })
})

describe('PetService 变更订阅', () => {
  it('onChange 在状态/显示变化与 notifyConfigChanged 时触发,退订后不再触发', () => {
    const { service, emit } = makeHarness()
    const listener = vi.fn()
    const unsubscribe = service.onChange(listener)
    emit('agent/status', { status: 'running' })
    expect(listener).toHaveBeenCalledTimes(1)
    service.setDisplay({ size: 200 })
    expect(listener).toHaveBeenCalledTimes(2)
    service.notifyConfigChanged()
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    emit('agent/error', {})
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('同一状态重复事件不触发通知', () => {
    const { service, emit } = makeHarness()
    const listener = vi.fn()
    service.onChange(listener)
    emit('agent/status', { status: 'running' })
    emit('agent/status', { status: 'running' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('done 保持期计时回收回 idle 也触发通知', () => {
    const { service, emit } = makeHarness()
    const listener = vi.fn()
    service.onChange(listener)
    emit('agent/turn-stopping', {})
    expect(listener).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3500)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
