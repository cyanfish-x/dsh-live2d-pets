/**
 * 桌宠配置设置页（`settings.section` 注册体，spec §2）。
 * 六项设置：开关 / 尺寸滑杆 / 渲染帧率 / 人设 / 模型列表（内置只读 + 自定义增删改）/ 调试模式。
 * 读写经插件自己的同源 API `/api/live2d-pet/settings`（Host 直连 ctx.settings，
 * 持久化到 settings.yaml 用户层）——不走 client settingsScope wire，因为
 * dsh-host-apiproxy 只把内置 allowlist 的 namespace 暴露给浏览器
 * （见 docs/research/settings-tab.md「设置服务不可用」根因）。
 * 不引入任何非平台模块值导入。
 * @module dsh-live2d-pets/client/settings
 */

import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent, MouseEvent, ReactNode, ReactElement } from 'react'
import type { CustomModelEntry, SpatialTapOverride } from '../index.ts'
import type { BuiltinPreset } from '../models.ts'
import {
  ANIMATION_SLOTS,
  DEFAULT_SPATIAL_TAP,
  isSupportedModelLocation,
  type AnimationSlot,
  type MotionMap,
} from '../models.ts'
import type { CustomPersonaDef } from '../persona-shared.ts'
import { PERSONAS_TEMPLATE } from '../persona-shared.ts'
import { builtinPersonaOptions } from './personas.ts'

/** settings namespace 的解析值（与 Host Config 对齐）。 */
export interface PetSettingsValue {
  enabled: boolean
  size: number
  /** 渲染帧率：30 / 60 / 0（不限制）。 */
  maxFps: number
  model: string
  /** 开发者选项总开关：开启后显示调试面板/点击分区等开发者入口。 */
  developerMode: boolean
  /** 调试面板：显示调试面板（开发用）。 */
  debug: boolean
  /** 显示点击分区叠加层（空间回退色块）。 */
  showTapZones: boolean
  persona: string
}

interface SettingsView {
  value?: PetSettingsValue
  writable?: boolean
}

interface SettingsState {
  status: 'loading' | 'ready' | 'unavailable'
  value?: PetSettingsValue
  writable: boolean
}

const DEFAULT_VALUE: PetSettingsValue = {
  enabled: true,
  size: 160,
  maxFps: 30,
  model: 'hiyori',
  developerMode: false,
  debug: false,
  showTapZones: false,
  persona: 'tsundere',
}

/** 空间分区覆盖表单草稿（空字符串 = 该字段用全局默认）。 */
type SpatialTapDraft = Record<keyof typeof DEFAULT_SPATIAL_TAP, string>

const EMPTY_SPATIAL_DRAFT: SpatialTapDraft = {
  headMaxNy: '',
  legMinNy: '',
  armMinNy: '',
  headMinNx: '',
  headMaxNx: '',
  bodyMinNx: '',
  bodyMaxNx: '',
  armLeftMinNx: '',
  armRightMaxNx: '',
}

const SPATIAL_FIELD_LABELS: { key: keyof SpatialTapDraft; label: string; hint: string }[] = [
  { key: 'headMaxNy', label: '头下沿', hint: String(DEFAULT_SPATIAL_TAP.headMaxNy) },
  { key: 'legMinNy', label: '腿上沿', hint: String(DEFAULT_SPATIAL_TAP.legMinNy) },
  { key: 'armMinNy', label: '手臂顶', hint: String(DEFAULT_SPATIAL_TAP.armMinNy) },
  { key: 'headMinNx', label: '头左', hint: String(DEFAULT_SPATIAL_TAP.headMinNx) },
  { key: 'headMaxNx', label: '头右', hint: String(DEFAULT_SPATIAL_TAP.headMaxNx) },
  { key: 'bodyMinNx', label: '身左', hint: String(DEFAULT_SPATIAL_TAP.bodyMinNx) },
  { key: 'bodyMaxNx', label: '身右', hint: String(DEFAULT_SPATIAL_TAP.bodyMaxNx) },
  { key: 'armLeftMinNx', label: '左臂左', hint: String(DEFAULT_SPATIAL_TAP.armLeftMinNx) },
  { key: 'armRightMaxNx', label: '右臂右', hint: String(DEFAULT_SPATIAL_TAP.armRightMaxNx) },
]

/** 动画映射槽位中文名（设置页「动画映射」表单）。 */
const ANIMATION_SLOT_LABELS: Record<AnimationSlot, string> = {
  idle: '空闲',
  thinking: '思考',
  error: '出错',
  done: '完成',
  waiting: '等待审批',
  head: '摸头',
  leg: '摸腿',
  arm: '摸手',
  body: '摸身体',
}

/** 动画映射草稿 → 存储对象；全空返回 undefined（不写字段）。 */
function motionMapFromDraft(draft: MotionMap): MotionMap | undefined {
  const out: MotionMap = {}
  for (const slot of ANIMATION_SLOTS) {
    const groups = (draft[slot] ?? []).filter(Boolean)
    if (groups.length > 0) out[slot] = groups
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 存储对象 → 表单草稿（未配置槽位为空数组）。 */
function draftFromMotionMap(m?: MotionMap | null): MotionMap {
  const draft: MotionMap = {}
  for (const slot of ANIMATION_SLOTS) draft[slot] = [...(m?.[slot] ?? [])]
  return draft
}

/** 从 .model3.json 解析动作组名列表（FileReferences.Motions 或顶层 Motions）。 */
async function fetchMotionGroups(url: string): Promise<string[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as {
    FileReferences?: { Motions?: Record<string, unknown> }
    Motions?: Record<string, unknown>
  }
  const motions = data?.FileReferences?.Motions ?? data?.Motions ?? {}
  return Object.keys(motions)
}

function draftFromOverride(o?: SpatialTapOverride | null): SpatialTapDraft {
  return {
    headMaxNy: o?.headMaxNy != null ? String(o.headMaxNy) : '',
    legMinNy: o?.legMinNy != null ? String(o.legMinNy) : '',
    armMinNy: o?.armMinNy != null ? String(o.armMinNy) : '',
    headMinNx: o?.headMinNx != null ? String(o.headMinNx) : '',
    headMaxNx: o?.headMaxNx != null ? String(o.headMaxNx) : '',
    bodyMinNx: o?.bodyMinNx != null ? String(o.bodyMinNx) : (o?.armLeftMaxNx != null ? String(o.armLeftMaxNx) : ''),
    bodyMaxNx: o?.bodyMaxNx != null ? String(o.bodyMaxNx) : (o?.armRightMinNx != null ? String(o.armRightMinNx) : ''),
    armLeftMinNx: o?.armLeftMinNx != null ? String(o.armLeftMinNx) : '',
    armRightMaxNx: o?.armRightMaxNx != null ? String(o.armRightMaxNx) : '',
  }
}

/** 草稿 → 覆盖对象；全空则 undefined（不写字段）。 */
function overrideFromDraft(d: SpatialTapDraft): SpatialTapOverride | undefined {
  const out: SpatialTapOverride = {}
  for (const { key } of SPATIAL_FIELD_LABELS) {
    const raw = d[key].trim()
    if (!raw) continue
    const n = Number(raw)
    if (!Number.isFinite(n)) continue
    out[key] = Math.min(1, Math.max(0, n))
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const SETTINGS_API = '/api/live2d-pet/settings'
const MODELS_API = '/api/live2d-pet/models'
const CUSTOM_MODELS_API = '/api/live2d-pet/custom-models'
const STATE_API = '/api/live2d-pet/state'
const RELOAD_PERSONAS_API = '/api/live2d-pet/reload-personas'
const LIST_LOCAL_DIR_API = '/api/live2d-pet/list-local-dir'

const rowStyle: CSSProperties = {
  padding: '10px 12px',
  marginBottom: 8,
  borderRadius: 8,
  background: 'rgba(128,128,128,.08)',
}

const labelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  flex: 1,
  minWidth: 0,
}

const linkStyle: CSSProperties = {
  color: 'inherit',
  fontSize: 12,
  marginLeft: 8,
}

const buttonStyle: CSSProperties = {
  marginLeft: 6,
  padding: '2px 10px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  background: 'rgba(128,128,128,.14)',
  color: 'inherit',
  border: 'none',
}

/** 自定义模型“空间分区覆盖 / 动画映射”tab 样式。 */
const panelTabStyle: CSSProperties = {
  ...buttonStyle,
  marginLeft: 0,
  padding: '4px 12px',
  borderRadius: 6,
}
const panelTabActiveStyle: CSSProperties = {
  ...panelTabStyle,
  background: 'rgba(120,170,255,.26)',
  color: '#fff',
}

/** 分组标题右侧的链接型操作（蓝色、hover 下划线），与“打开内置模型配置文件”一致。 */
function headerLink(text: string, onClick: () => void): ReactElement {
  return createElement('a', {
    href: '#',
    style: {
      color: '#4a9eff',
      fontSize: 12,
      textDecoration: 'none',
      cursor: 'pointer',
    },
    onMouseEnter: (e: MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.textDecoration = 'underline' },
    onMouseLeave: (e: MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.textDecoration = 'none' },
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      onClick()
    },
  }, text)
}

const inputStyle: CSSProperties = {
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid rgba(128,128,128,.35)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  minWidth: 0,
  flex: 1,
}

function spatialTapFields(
  draft: SpatialTapDraft,
  setDraft: (next: SpatialTapDraft) => void,
  disabled: boolean,
): ReactElement {
  return createElement('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(88px,1fr))', gap: 6, marginTop: 8 },
  },
    ...SPATIAL_FIELD_LABELS.map(({ key, label, hint }) => createElement('label', {
      key,
      style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#888' },
    },
      `${label} (默认 ${hint})`,
      createElement('input', {
        style: { ...inputStyle, width: '100%', boxSizing: 'border-box' as const },
        inputMode: 'decimal',
        placeholder: hint,
        disabled,
        value: draft[key],
        onChange: (e: ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: e.target.value }),
      }),
    )),
  )
}

/** 动画映射表单：9 个槽位各一个多选下拉；解析失败时显示重试。 */
function motionMapFields(
  draft: MotionMap,
  setDraft: (next: MotionMap) => void,
  groups: readonly string[],
  status: 'idle' | 'loading' | 'ready' | 'error',
  disabled: boolean,
  onRetry?: () => void,
): ReactElement {
  const options = groups.map((g) => ({ id: g, name: g }))
  const statusLine = status === 'loading'
    ? '正在解析模型动画列表…'
    : status === 'error'
      ? '无法解析动画列表，可稍后重试（模型仍可保存）'
      : status === 'ready'
        ? `已解析到 ${groups.length} 个动作组；多选=触发时随机选一个`
        : '打开后实时解析模型动画列表；未配置的槽位沿用默认映射。'
  return createElement('div', { style: { marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 10px' } },
    createElement('div', { style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#888' } },
      createElement('span', null, statusLine),
      status === 'error' && onRetry
        ? createElement('button', { type: 'button', style: buttonStyle, onClick: onRetry }, '重试')
        : null,
    ),
    ...ANIMATION_SLOTS.map((slot) => createElement('label', {
      key: slot,
      style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, minWidth: 0 },
    },
      createElement('span', { style: { color: '#888' } }, ANIMATION_SLOT_LABELS[slot]),
      createElement(ThemeMultiSelect, {
        value: draft[slot] ?? [],
        options,
        disabled: disabled || status !== 'ready',
        placeholder: '未配置（用默认）',
        onChange: (next) => setDraft({ ...draft, [slot]: next }),
      }),
    )),
  )
}

const sectionTitleStyle: CSSProperties = {
  margin: '16px 0 8px',
  fontSize: 13,
  fontWeight: 600,
  color: '#888',
}

/** 下拉选项（与设置页其它控件同色板，避免原生 select 的白框/底线）。 */
interface ThemeSelectOption {
  id: string
  name: string
}

const MAX_FPS_OPTIONS: ThemeSelectOption[] = [
  { id: '30', name: '30' },
  { id: '60', name: '60' },
  { id: '0', name: '不限制帧率' },
]

/** 归一化设置里的帧率档（非法值回落默认 30）。 */
function normalizeMaxFps(raw: unknown): number {
  if (raw === 60 || raw === 0) return raw
  return 30
}

interface ThemeSelectProps {
  value: string
  options: ThemeSelectOption[]
  disabled?: boolean
  onChange: (id: string) => void
}

interface ThemeRadioGroupProps {
  value: string
  options: ThemeSelectOption[]
  disabled?: boolean
  name: string
  onChange: (id: string) => void
}

/** 选中态强调色（与设置页其它高亮一致，贴近系统 radio 蓝点观感）。 */
const RADIO_ACCENT = 'rgba(90,150,255,.95)'
const RADIO_RING = 'rgba(160,160,170,.75)'

/** 自绘圆点：帧率档与模型列表共用，避免原生 radio 深色主题白框。 */
function ThemeRadioDot(props: { selected: boolean }): ReactElement {
  const { selected } = props
  return createElement('span', {
    'aria-hidden': true,
    style: {
      width: 14,
      height: 14,
      borderRadius: '50%',
      boxSizing: 'border-box',
      border: `1.5px solid ${selected ? RADIO_ACCENT : RADIO_RING}`,
      background: 'transparent',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
  },
    selected
      ? createElement('span', {
        style: {
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: RADIO_ACCENT,
        },
      })
      : null,
  )
}

interface ThemeRadioOptionProps {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  children: ReactNode
  style?: CSSProperties
}

/** 可点的圆点 + 文案行（帧率横排 / 模型行复用）。 */
function ThemeRadioOption(props: ThemeRadioOptionProps): ReactElement {
  const { selected, disabled, onSelect, children, style } = props
  return createElement('button', {
    type: 'button',
    role: 'radio',
    'aria-checked': selected,
    disabled: !!disabled,
    onClick: () => { if (!disabled && !selected) onSelect() },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      margin: 0,
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      cursor: disabled ? 'not-allowed' : 'pointer',
      outline: 'none',
      minWidth: 0,
      ...style,
    },
  },
    createElement(ThemeRadioDot, { selected }),
    children,
  )
}

/**
 * 自绘圆形单选组：一行多档；圆点走 ThemeRadioDot。
 */
function ThemeRadioGroup(props: ThemeRadioGroupProps): ReactElement {
  const { value, options, disabled, name, onChange } = props
  return createElement('div', {
    role: 'radiogroup',
    'aria-label': name,
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '10px 18px',
      opacity: disabled ? 0.55 : 1,
    },
  },
    options.map((o) => createElement(ThemeRadioOption, {
      key: o.id,
      selected: o.id === value,
      disabled,
      onSelect: () => onChange(o.id),
      children: createElement('span', null, o.name),
    })),
  )
}

interface ThemeSwitchProps {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}

/** 自绘 switch：用于开发者选项总开关等“组标题右侧开关”场景。 */
function ThemeSwitch(props: ThemeSwitchProps): ReactElement {
  const { checked, disabled, onChange } = props
  return createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    disabled: !!disabled,
    onClick: () => { if (!disabled) onChange(!checked) },
    style: {
      position: 'relative',
      width: 38,
      height: 20,
      flexShrink: 0,
      padding: 0,
      border: 'none',
      borderRadius: 10,
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: checked ? RADIO_ACCENT : 'rgba(128,128,128,.35)',
      opacity: disabled ? 0.55 : 1,
      transition: 'background .15s',
      outline: 'none',
    },
  },
    createElement('span', {
      style: {
        position: 'absolute',
        top: 2,
        left: checked ? 20 : 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,.4)',
        transition: 'left .15s',
      },
    }),
  )
}

/**
 * 自绘下拉：原生 select 在 Windows 深色主题下会出焦点白框与 options 底部白线，
 * UA 弹出层几乎不可主题化，故用同色板菜单替代。
 */
function ThemeSelect(props: ThemeSelectProps): ReactElement {
  const { value, options, disabled, onChange } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const label = options.find((o) => o.id === value)?.name ?? value

  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return createElement('div', {
    ref: rootRef,
    style: { position: 'relative', flex: 1, minWidth: 0 },
  },
    createElement('button', {
      type: 'button',
      disabled: !!disabled,
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      onClick: () => { if (!disabled) setOpen((v) => !v) },
      style: {
        ...inputStyle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: 'rgba(128,128,128,.14)',
        outline: 'none',
        boxShadow: 'none',
        opacity: disabled ? 0.55 : 1,
      },
    },
      createElement('span', {
        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, label),
      createElement('span', { style: { color: '#888', fontSize: 10, flexShrink: 0 } }, open ? '▴' : '▾'),
    ),
    open && createElement('div', {
      role: 'listbox',
      style: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 'calc(100% + 4px)',
        zIndex: 20,
        margin: 0,
        padding: 4,
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,.35)',
        background: '#2a2a2e',
        color: '#e8e8ec',
        boxShadow: '0 8px 24px rgba(0,0,0,.45)',
        maxHeight: 240,
        overflowY: 'auto',
      },
    },
      options.map((o) => {
        const selected = o.id === value
        return createElement('button', {
          key: o.id,
          type: 'button',
          role: 'option',
          'aria-selected': selected,
          onClick: () => { onChange(o.id); setOpen(false) },
          style: {
            display: 'block',
            width: '100%',
            margin: 0,
            padding: '6px 10px',
            border: 'none',
            borderRadius: 6,
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: 13,
            color: '#e8e8ec',
            background: selected ? 'rgba(120,170,255,.28)' : 'transparent',
            outline: 'none',
          },
          onMouseEnter: (e: MouseEvent<HTMLButtonElement>) => {
            if (!selected) e.currentTarget.style.background = 'rgba(128,128,128,.22)'
          },
          onMouseLeave: (e: MouseEvent<HTMLButtonElement>) => {
            e.currentTarget.style.background = selected ? 'rgba(120,170,255,.28)' : 'transparent'
          },
        }, o.name)
      }),
    ),
  )
}

interface ThemeMultiSelectProps {
  value: string[]
  options: ThemeSelectOption[]
  disabled?: boolean
  placeholder?: string
  onChange: (next: string[]) => void
}

/** 多选下拉：选中项以 tag 展示在主按钮内；点击下拉项切换选中，保持打开以支持连续多选。 */
function ThemeMultiSelect(props: ThemeMultiSelectProps): ReactElement {
  const { value, options, disabled, placeholder, onChange } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? id

  return createElement('div', {
    ref: rootRef,
    style: { position: 'relative', flex: 1, minWidth: 0 },
  },
    createElement('button', {
      type: 'button',
      disabled: !!disabled,
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      onClick: () => { if (!disabled) setOpen((v) => !v) },
      style: {
        ...inputStyle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        width: '100%',
        minHeight: 34,
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: 'rgba(128,128,128,.14)',
        outline: 'none',
        boxShadow: 'none',
        opacity: disabled ? 0.55 : 1,
      },
    },
      createElement('span', {
        style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', flex: 1, minWidth: 0 },
      },
        value.length === 0
          ? createElement('span', { style: { color: '#888' } }, placeholder ?? '选择动作组')
          : value.map((id) => createElement('span', {
            key: id,
            style: {
              padding: '1px 6px',
              borderRadius: 4,
              background: 'rgba(120,170,255,.22)',
              color: '#dbe7ff',
              fontSize: 11,
              whiteSpace: 'nowrap',
            },
          }, nameOf(id))),
      ),
      createElement('span', { style: { color: '#888', fontSize: 10, flexShrink: 0 } }, open ? '▴' : '▾'),
    ),
    open && createElement('div', {
      role: 'listbox',
      'aria-multiselectable': true,
      style: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 'calc(100% + 4px)',
        zIndex: 20,
        margin: 0,
        padding: 4,
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,.35)',
        background: '#2a2a2e',
        color: '#e8e8ec',
        boxShadow: '0 8px 24px rgba(0,0,0,.45)',
        maxHeight: 240,
        overflowY: 'auto',
      },
    },
      options.map((o) => {
        const selected = value.includes(o.id)
        return createElement('button', {
          key: o.id,
          type: 'button',
          role: 'option',
          'aria-selected': selected,
          onClick: () => {
            const next = selected ? value.filter((v) => v !== o.id) : [...value, o.id]
            onChange(next)
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            margin: 0,
            padding: '6px 10px',
            border: 'none',
            borderRadius: 6,
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: 13,
            color: '#e8e8ec',
            background: selected ? 'rgba(120,170,255,.28)' : 'transparent',
            outline: 'none',
          },
          onMouseEnter: (e: MouseEvent<HTMLButtonElement>) => {
            if (!selected) e.currentTarget.style.background = 'rgba(128,128,128,.22)'
          },
          onMouseLeave: (e: MouseEvent<HTMLButtonElement>) => {
            e.currentTarget.style.background = selected ? 'rgba(120,170,255,.28)' : 'transparent'
          },
        },
          createElement('span', { style: { width: 14, flexShrink: 0, textAlign: 'center' } }, selected ? '☑' : '☐'),
          o.name,
        )
      }),
    ),
  )
}

/** 设置路径 op（与 Host settings.mutate 对齐）。 */
type SettingsOp = { op: 'set' | 'unset'; path: string[]; value?: unknown }

/** 读取设置（GET）。 */
async function loadSettings(): Promise<SettingsView | null> {
  try {
    const response = await fetch(SETTINGS_API)
    if (!response.ok) return null
    return await response.json() as SettingsView
  } catch {
    return null
  }
}

/** 写入设置（POST 路径 op；返回写后视图）。 */
async function writeSettings(ops: SettingsOp[]): Promise<SettingsView | null> {
  try {
    const response = await fetch(SETTINGS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops }),
    })
    if (!response.ok) return null
    return await response.json() as SettingsView
  } catch {
    return null
  }
}

/** 读取自定义模型文件（GET）。 */
async function loadCustomModels(): Promise<{
  models: CustomModelEntry[]
  error: string | null
  path: string
} | null> {
  try {
    const response = await fetch(CUSTOM_MODELS_API)
    if (!response.ok) return null
    return await response.json() as { models: CustomModelEntry[]; error: string | null; path: string }
  } catch {
    return null
  }
}

/** 写回自定义模型文件（POST 全量列表）。 */
async function saveCustomModelsFile(models: CustomModelEntry[]): Promise<{
  models: CustomModelEntry[]
  error: string | null
  path: string
} | null> {
  try {
    const response = await fetch(CUSTOM_MODELS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models }),
    })
    if (!response.ok) return null
    return await response.json() as { models: CustomModelEntry[]; error: string | null; path: string }
  } catch {
    return null
  }
}

/** 单个模型行（自绘 radio + 元信息 + 右侧操作；圆点与帧率档共用 ThemeRadioDot）。 */
function modelRow(
  key: string,
  selected: boolean,
  onSelect: () => void,
  meta: string,
  disabled: boolean,
  actions?: ReactNode,
  licenseLink?: ReactNode,
): ReactElement {
  return createElement('div', { key, style: { ...rowStyle, display: 'flex', alignItems: 'center', gap: 8 } },
    createElement(ThemeRadioOption, {
      selected,
      disabled,
      onSelect,
      style: { ...labelStyle, margin: 0, flex: 1 },
      children: createElement('span', {
        style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' },
      }, meta),
    }),
    licenseLink,
    actions,
  )
}

/** 「自定义人设 ↗」直达打开（由插件入口注入；返回是否成功，失败走弹层兜底）。 */
export interface PetSettingsProps {
  openPath?: (path: string) => Promise<boolean>
}

interface PersonaStateView {
  persona: string
  customPersonas: CustomPersonaDef[]
  personasError: string | null
  personasFile: string
}

/** 拉取宠物状态（人设区数据源）。 */
async function loadPersonaState(): Promise<PersonaStateView | null> {
  try {
    const response = await fetch(STATE_API)
    if (!response.ok) return null
    return await response.json() as PersonaStateView
  } catch {
    return null
  }
}

/** 写剪贴板（尽力而为）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 本地目录浏览的一行（子目录 / `.model3.json` 文件）。 */
interface LocalListingEntry {
  name: string
  path: string
}

/** Host 返回的本地目录列表。 */
interface LocalListing {
  path: string
  home: string
  parent: string | null
  files: LocalListingEntry[]
  dirs: LocalListingEntry[]
}

/** 读取某个本地目录（不依赖 DSH directoryPicker，插件自研浏览）。 */
async function listLocalDir(path: string | null): Promise<LocalListing | null> {
  try {
    const response = await fetch(LIST_LOCAL_DIR_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!response.ok) return null
    const data = await response.json() as { ok?: boolean; listing?: LocalListing | null }
    return data.listing ?? null
  } catch {
    return null
  }
}

/** 「选择本地文件」弹层：插件自研的目录浏览（不依赖 DSH directoryPicker 服务）。
 *  逐级点击子目录进入，点击 `.model3.json` 文件即回填其绝对路径。 */
function LocalFileBrowser(props: { onPick: (path: string) => void; onClose: () => void }): ReactNode {
  const { onPick, onClose } = props
  const [path, setPath] = useState<string | null>(null)
  const [listing, setListing] = useState<LocalListing | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  const openDir = useCallback((target: string | null) => {
    setStatus('loading')
    setError(null)
    void listLocalDir(target).then((l) => {
      if (l) {
        setListing(l)
        setPath(l.path)
        setStatus('ready')
      } else {
        setStatus('error')
        setError(target ? `无法读取目录：${target}` : '无法读取家目录')
      }
    })
  }, [])

  useEffect(() => { openDir(null) }, [openDir])

  const mkRow = (entry: LocalListingEntry, isDir: boolean): ReactElement => {
    const label = isDir ? `▸ ${entry.name}/` : entry.name
    return createElement('button', {
      key: entry.path,
      type: 'button',
      onClick: () => { isDir ? openDir(entry.path) : onPick(entry.path) },
      style: {
        display: 'block',
        width: '100%',
        margin: 0,
        padding: '5px 8px',
        border: 'none',
        borderRadius: 6,
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 13,
        color: '#e8e8ec',
        background: 'transparent',
        outline: 'none',
        fontFamily: 'monospace',
      },
      onMouseEnter: (e: MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'rgba(128,128,128,.22)' },
      onMouseLeave: (e: MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'transparent' },
    }, label)
  }

  return createElement('div', {
    style: {
      marginTop: 8,
      padding: '8px 10px',
      borderRadius: 8,
      border: '1px solid rgba(128,128,128,.35)',
      background: '#2a2a2e',
      fontSize: 12,
    },
  },
    createElement('div', {
      style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' },
    },
      createElement('button', {
        type: 'button',
        style: buttonStyle,
        onClick: () => openDir(listing?.home ?? null),
      }, '🏠 家目录'),
      createElement('button', {
        type: 'button',
        style: buttonStyle,
        disabled: !listing?.parent,
        onClick: () => { if (listing?.parent) openDir(listing.parent) },
      }, '⬆ 上级'),
      createElement('span', {
        style: { color: '#888', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', wordBreak: 'break-all' },
      }, listing?.path ?? '…'),
      createElement('button', { type: 'button', style: buttonStyle, onClick: onClose }, '取消'),
    ),
    status === 'loading' && createElement('div', { style: { color: '#888', padding: '6px 0' } }, '读取目录中…'),
    status === 'error' && createElement('div', { style: { color: '#b45309', padding: '6px 0' } }, error ?? '目录不可用'),
    status === 'ready' && createElement('div', {
      style: { maxHeight: 240, overflowY: 'auto', borderTop: '1px solid rgba(128,128,128,.2)', paddingTop: 4 },
    },
      listing!.dirs.length === 0 && listing!.files.length === 0
        ? createElement('div', { style: { color: '#888', padding: '6px 0' } }, '此目录下没有子目录或 .model3.json 文件')
        : null,
      listing!.dirs.map((d) => mkRow(d, true)),
      listing!.files.map((f) => mkRow(f, false)),
    ),
  )
}

export function PetSettingsSection(props: PetSettingsProps): ReactNode {
  const [state, setState] = useState<SettingsState>({ status: 'loading', writable: false })
  // 最新视图 ref：写入 ops 在出队时按最新状态合成，避免快速操作读到过期闭包
  const stateRef = useRef(state)
  const setSettingsState = (next: SettingsState | ((prev: SettingsState) => SettingsState)): void => {
    const resolved = typeof next === 'function' ? next(stateRef.current) : next
    stateRef.current = resolved
    setState(resolved)
  }
  const reload = useCallback(() => {
    loadSettings().then((view) => {
      if (view === null) {
        setSettingsState((prev) => prev.status === 'ready' ? prev : { status: 'unavailable', writable: false })
        return
      }
      setSettingsState({ status: 'ready', value: view.value, writable: view.writable !== false })
    })
  }, [])
  useEffect(() => { reload() }, [reload])

  const value = state.value ?? DEFAULT_VALUE
  const writable = state.writable

  // 内置清单（Host API，只读）
  const [builtin, setBuiltin] = useState<BuiltinPreset[]>([])
  const [presetsPath, setPresetsPath] = useState<string>('')
  const [customModelsPath, setCustomModelsPath] = useState<string>('')
  useEffect(() => {
    let alive = true
    fetch(MODELS_API)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive || !data) return
        if (Array.isArray(data.builtin)) setBuiltin(data.builtin)
        if (typeof data.presetsPath === 'string') setPresetsPath(data.presetsPath)
        if (typeof data.customModelsPath === 'string') setCustomModelsPath(data.customModelsPath)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // 自定义模型（独立 JSONC 文件，不再混入 settings.yaml）
  const [customModels, setCustomModels] = useState<CustomModelEntry[]>([])
  const [customModelsError, setCustomModelsError] = useState<string | null>(null)
  const reloadCustomModels = useCallback(() => {
    loadCustomModels().then((view) => {
      if (view === null) return
      setCustomModels(view.models)
      setCustomModelsError(view.error)
      if (view.path) setCustomModelsPath(view.path)
    })
  }, [])
  useEffect(() => { reloadCustomModels() }, [reloadCustomModels])

  // 内置模型配置文件打开（开发者选项）：与「自定义人设 ↗」同款交互
  const [builtinFileNotice, setBuiltinFileNotice] = useState<string | null>(null)
  const [showBuiltinFilePopover, setShowBuiltinFilePopover] = useState(false)
  const openBuiltinPresetsFile = () => {
    if (!presetsPath) {
      setBuiltinFileNotice('内置模型配置文件路径不可用')
      return
    }
    const opened = props.openPath?.(presetsPath) ?? Promise.resolve(false)
    opened.then((ok) => {
      if (ok) {
        setBuiltinFileNotice('已打开内置模型配置文件')
      } else {
        setShowBuiltinFilePopover(true)
      }
    })
  }

  // 自定义模型配置文件（custom-models.jsonc）打开：同款交互
  const [customFileNotice, setCustomFileNotice] = useState<string | null>(null)
  const [showCustomFilePopover, setShowCustomFilePopover] = useState(false)
  const openCustomModelsFile = () => {
    if (!customModelsPath) {
      setCustomFileNotice('自定义模型配置文件路径不可用')
      return
    }
    const opened = props.openPath?.(customModelsPath) ?? Promise.resolve(false)
    opened.then((ok) => {
      if (ok) {
        setCustomFileNotice('已打开自定义模型配置文件')
      } else {
        setShowCustomFilePopover(true)
      }
    })
  }

  // 尺寸滑杆：拖动中本地草稿，松手/失焦提交（避免拖动写满 settings.yaml）
  const [draftSize, setDraftSize] = useState<number | null>(null)
  useEffect(() => { setDraftSize(null) }, [value.size])
  const size = draftSize ?? value.size
  const commitSize = () => {
    if (draftSize === null) return
    const nextSize = draftSize
    enqueueWrite(() => [{ op: 'set', path: ['size'], value: nextSize }])
    setDraftSize(null)
  }

  // 自定义模型表单（添加 + 编辑）
  const [browseTarget, setBrowseTarget] = useState<'new' | 'edit' | null>(null)
  const [newFormNotice, setNewFormNotice] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newSpatial, setNewSpatial] = useState<SpatialTapDraft>(EMPTY_SPATIAL_DRAFT)
  const [activeNewPanel, setActiveNewPanel] = useState<'spatial' | 'motion' | null>(null)
  const [newMotionMap, setNewMotionMap] = useState<MotionMap>({})
  const [newMotionGroups, setNewMotionGroups] = useState<string[]>([])
  const [newMotionStatus, setNewMotionStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editSpatial, setEditSpatial] = useState<SpatialTapDraft>(EMPTY_SPATIAL_DRAFT)
  const [activeEditPanel, setActiveEditPanel] = useState<'spatial' | 'motion' | null>(null)
  const [editMotionMap, setEditMotionMap] = useState<MotionMap>({})
  const [editMotionGroups, setEditMotionGroups] = useState<string[]>([])
  const [editMotionStatus, setEditMotionStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  const custom = customModels
  const customRef = useRef(custom)
  customRef.current = custom

  // 新增模型：打开「动画映射」或 URL 变化时实时解析动作组
  useEffect(() => {
    if (activeNewPanel !== 'motion' || !isSupportedModelLocation(newUrl)) return
    let alive = true
    setNewMotionStatus('loading')
    fetchMotionGroups(newUrl)
      .then((groups) => {
        if (!alive) return
        setNewMotionGroups(groups)
        setNewMotionStatus('ready')
      })
      .catch(() => {
        if (!alive) return
        setNewMotionGroups([])
        setNewMotionStatus('error')
      })
    return () => { alive = false }
  }, [activeNewPanel, newUrl])

  // 编辑模型：同上
  useEffect(() => {
    if (activeEditPanel !== 'motion' || !isSupportedModelLocation(editUrl)) return
    let alive = true
    setEditMotionStatus('loading')
    fetchMotionGroups(editUrl)
      .then((groups) => {
        if (!alive) return
        setEditMotionGroups(groups)
        setEditMotionStatus('ready')
      })
      .catch(() => {
        if (!alive) return
        setEditMotionGroups([])
        setEditMotionStatus('error')
      })
    return () => { alive = false }
  }, [activeEditPanel, editUrl])

  // 写入串行化：ops 在出队时基于最新视图合成。若直接用渲染闭包里的
  // custom/value 组合完整数组替换，快速连续操作（如连删两个模型）会
  // 读到过期状态，后到的写覆盖先到的，导致已删条目被"复活"。
  const writeQueue = useRef<Promise<void>>(Promise.resolve())
  const enqueueWrite = (compose: (current: PetSettingsValue) => SettingsOp[]): void => {
    writeQueue.current = writeQueue.current.then(async () => {
      const current = stateRef.current.value ?? DEFAULT_VALUE
      const view = await writeSettings(compose(current))
      if (view !== null) setSettingsState({ status: 'ready', value: view.value, writable: view.writable !== false })
    })
  }

  // 自定义模型文件写入串行化（独立于 settings.yaml 写入队列）
  const customWriteQueue = useRef<Promise<void>>(Promise.resolve())
  const enqueueCustomWrite = (compose: (current: CustomModelEntry[]) => CustomModelEntry[]): void => {
    customWriteQueue.current = customWriteQueue.current.then(async () => {
      const view = await saveCustomModelsFile(compose(customRef.current))
      if (view !== null) {
        setCustomModels(view.models)
        setCustomModelsError(view.error)
        if (view.path) setCustomModelsPath(view.path)
      }
    })
  }

  const addModel = () => {
    const name = newName.trim()
    const url = newUrl.trim()
    if (!name) {
      setNewFormNotice('请填写模型名称')
      return
    }
    if (!isSupportedModelLocation(url)) {
      setNewFormNotice('模型地址无效：仅支持 http(s) URL 或本地绝对路径（/…、~/…、C:/…）')
      return
    }
    const spatialTap = overrideFromDraft(newSpatial)
    const animationMap = motionMapFromDraft(newMotionMap)
    const entry: CustomModelEntry = { id: `m${Date.now()}`, name, modelUrl: url }
    if (spatialTap) entry.spatialTap = spatialTap
    if (animationMap) entry.animationMap = animationMap
    enqueueCustomWrite((current) => [...current, entry])
    setNewFormNotice(null)
    setNewName('')
    setNewUrl('')
    setNewSpatial(EMPTY_SPATIAL_DRAFT)
    setActiveNewPanel(null)
    setNewMotionMap({})
    setNewMotionGroups([])
    setNewMotionStatus('idle')
  }

  const saveEdit = (id: string) => {
    const name = editName.trim()
    const url = editUrl.trim()
    if (!name || !isSupportedModelLocation(url)) return
    const spatialTap = overrideFromDraft(editSpatial)
    const animationMap = motionMapFromDraft(editMotionMap)
    enqueueCustomWrite((current) => current.map((c) => {
      if (c.id !== id) return c
      const next: CustomModelEntry = { id: c.id, name, modelUrl: url }
      if (spatialTap) next.spatialTap = spatialTap
      if (animationMap) next.animationMap = animationMap
      return next
    }))
    setEditId(null)
    setActiveEditPanel(null)
  }

  const beginEdit = (c: CustomModelEntry) => {
    setEditId(c.id)
    setEditName(c.name)
    setEditUrl(c.modelUrl)
    setEditSpatial(draftFromOverride(c.spatialTap))
    const hasSpatial = !!c.spatialTap && Object.keys(c.spatialTap).length > 0
    const hasMotion = !!c.animationMap && Object.keys(c.animationMap).length > 0
    setActiveEditPanel(hasSpatial ? 'spatial' : hasMotion ? 'motion' : null)
    setEditMotionMap(draftFromMotionMap(c.animationMap))
    setEditMotionGroups([])
    setEditMotionStatus('idle')
  }

  const removeModel = (id: string) => {
    // 删除的是当前选中模型时，回退到第一个内置模型（builtin 加载完成前用默认 id）
    const fallbackModel = builtin[0]?.id ?? 'hiyori'
    enqueueCustomWrite((current) => current.filter((c) => c.id !== id))
    if (value.model === id) {
      enqueueWrite(() => [{ op: 'set', path: ['model'], value: fallbackModel }])
    }
  }

  // ---- 人设区（spec §2/§3）：下拉选择 + 重新读取 + 自定义人设入口 ----
  const [personaState, setPersonaState] = useState<PersonaStateView | null>(null)
  const [personaNotice, setPersonaNotice] = useState<string | null>(null)
  const [showPersonaPopover, setShowPersonaPopover] = useState(false)
  const reloadPersonaState = useCallback(() => {
    loadPersonaState().then((view) => { if (view) setPersonaState(view) })
  }, [])
  useEffect(() => { reloadPersonaState() }, [reloadPersonaState])

  const builtinPersonaList = builtinPersonaOptions()
  const customPersonaList = personaState?.customPersonas ?? []
  const activePersona = personaState?.persona ?? value.persona

  const reloadPersonas = () => {
    setPersonaNotice('读取中…')
    fetch(RELOAD_PERSONAS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { error?: string | null } | null) => {
        reloadPersonaState()
        setPersonaNotice(data?.error ? `已重读：${data.error}` : '已重新读取人设文件')
      })
      .catch(() => setPersonaNotice('重新读取失败（Host 不可达）'))
  }

  const openPersonasFile = () => {
    const file = personaState?.personasFile
    if (!file) return
    const opened = props.openPath?.(file) ?? Promise.resolve(false)
    opened.then((ok) => {
      if (ok) {
        setPersonaNotice('已用系统默认程序打开人设文件')
      } else {
        setShowPersonaPopover(true)
      }
    })
  }

  // ---- 组装页面 ----
  const builtinRows = builtin.map((p) => modelRow(
    `builtin-${p.id}`,
    value.model === p.id,
    () => enqueueWrite(() => [{ op: 'set', path: ['model'], value: p.id }]),
    `${p.name}（${p.author}）`,
    !writable,
    undefined,
    createElement('a', {
      key: 'license',
      href: p.license?.url,
      target: '_blank',
      rel: 'noreferrer',
      style: linkStyle,
      onClick: (e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation(),
    }, p.license?.type ?? '许可'),
  ))

  const customRows = custom.map((c) => {
    const hasOverride = !!c.spatialTap && Object.keys(c.spatialTap).length > 0
    const hasMotionMap = !!c.animationMap && Object.keys(c.animationMap).length > 0
    if (editId === c.id) {
      return createElement('div', { key: c.id, style: { ...rowStyle, display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          createElement('input', {
            style: inputStyle,
            value: editName,
            placeholder: '名称',
            onChange: (e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value),
          }),
          createElement('input', {
            style: { ...inputStyle, flex: 1, minWidth: 120 },
            value: editUrl,
            placeholder: 'https://…/model3.json 或本地绝对路径（如 /home/…）',
            onChange: (e: ChangeEvent<HTMLInputElement>) => setEditUrl(e.target.value),
          }),
          createElement('button', {
            type: 'button',
            style: buttonStyle,
            onClick: () => setBrowseTarget('edit'),
          }, '选择本地文件'),
          createElement('button', { style: buttonStyle, onClick: () => saveEdit(c.id) }, '保存'),
          createElement('button', { style: buttonStyle, onClick: () => { setEditId(null); setActiveEditPanel(null) } }, '取消'),
        ),
        createElement('div', { key: 'edit-panel-tabs', style: { display: 'flex', gap: 4, marginTop: 4 } },
          createElement('button', {
            type: 'button',
            style: activeEditPanel === 'spatial' ? panelTabActiveStyle : panelTabStyle,
            onClick: () => setActiveEditPanel((v) => v === 'spatial' ? null : 'spatial'),
          }, '空间分区覆盖'),
          createElement('button', {
            type: 'button',
            style: activeEditPanel === 'motion' ? panelTabActiveStyle : panelTabStyle,
            onClick: () => setActiveEditPanel((v) => v === 'motion' ? null : 'motion'),
          }, '动画映射'),
        ),
        activeEditPanel === 'spatial' && createElement('div', { key: 'edit-spatial' },
          createElement('div', { style: { fontSize: 11, color: '#888', marginBottom: 4 } },
            '相对包围盒 0–1；留空=该字段用全局默认。改完请开「显示点击分区」对照色块。'),
          spatialTapFields(editSpatial, setEditSpatial, !writable),
        ),
        activeEditPanel === 'motion' && createElement('div', { key: 'edit-motion' },
          createElement('div', { style: { fontSize: 11, color: '#888', marginBottom: 4 } },
            '按状态/互动部位配置模型动作组；未配置项沿用默认。'),
          motionMapFields(editMotionMap, setEditMotionMap, editMotionGroups, editMotionStatus, !writable, () => {
            setActiveEditPanel(null)
            requestAnimationFrame(() => setActiveEditPanel('motion'))
          }),
        ),
      )
    }
    return modelRow(
      `custom-${c.id}`,
      value.model === c.id,
      () => enqueueWrite(() => [{ op: 'set', path: ['model'], value: c.id }]),
      [hasOverride ? '分区已覆盖' : null, hasMotionMap ? '动画已映射' : null].filter(Boolean).length > 0
        ? `${c.name} · ${[hasOverride ? '分区已覆盖' : null, hasMotionMap ? '动画已映射' : null].filter(Boolean).join(' · ')}`
        : c.name,
      !writable,
      createElement('span', { key: 'actions' },
        createElement('button', { style: buttonStyle, onClick: () => beginEdit(c) }, '修改'),
        createElement('button', { style: buttonStyle, onClick: () => removeModel(c.id) }, '删除'),
      ),
      undefined,
    )
  })

  const children: ReactNode[] = [
    createElement('h3', { key: 'title', style: { margin: '0 0 4px' } }, '桌宠配置'),
    createElement('p', { key: 'sub', style: { margin: '0 0 12px', color: '#888', fontSize: 12 } },
      '设置经 $DSH_HOME/settings.yaml 持久化，立即生效。'),
  ]

  if (state.status !== 'ready') {
    children.push(createElement('div', { key: 'notice', style: { ...rowStyle, color: '#b45309' } },
      state.status === 'unavailable' ? '设置服务不可用（Host 插件未加载）。' : '设置加载中…',
    ))
  }

  // 1. 开关
  children.push(createElement('div', { key: 'enabled', style: rowStyle },
    createElement('label', { style: labelStyle },
      createElement('input', {
        type: 'checkbox',
        checked: !!value.enabled,
        disabled: !writable,
        // 受控 checkbox 的事件期捕获：React 在 onChange 后会同步把 DOM
        // 复位回上次渲染值，若出队时才读 e.target.checked 永远读到旧值
        onChange: (e: ChangeEvent<HTMLInputElement>) => {
          const next = e.target.checked
          enqueueWrite(() => [{ op: 'set', path: ['enabled'], value: next }])
        },
      }),
      createElement('span', null, '显示宠物'),
    ),
  ))

  // 2. 尺寸滑杆
  children.push(createElement('div', { key: 'size', style: rowStyle },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      createElement('span', { style: { whiteSpace: 'nowrap' } }, '尺寸'),
      createElement('input', {
        type: 'range',
        min: 40,
        max: 400,
        step: 1,
        value: size,
        disabled: !writable,
        style: { flex: 1 },
        onChange: (e: ChangeEvent<HTMLInputElement>) => setDraftSize(Number(e.target.value)),
        onPointerUp: commitSize,
        onKeyUp: commitSize,
        onBlur: commitSize,
      }),
      createElement('span', { style: { width: 56, textAlign: 'right', color: '#888', fontSize: 12 } }, `${size}px`),
    ),
  ))

  // 3. 渲染帧率（spec §2/§7）：尺寸下方 group，自绘圆形单选立刻生效
  const maxFps = normalizeMaxFps(value.maxFps)
  children.push(createElement('div', { key: 'maxFps' },
    createElement('div', { style: sectionTitleStyle }, '渲染帧率'),
    createElement('div', { style: rowStyle },
      createElement(ThemeRadioGroup, {
        name: '渲染帧率',
        value: String(maxFps),
        options: MAX_FPS_OPTIONS,
        disabled: !writable,
        onChange: (id: string) => {
          enqueueWrite(() => [{ op: 'set', path: ['maxFps'], value: normalizeMaxFps(Number(id)) }])
        },
      }),
    ),
  ))

  // 4. 人设（spec §2/§3）：独立分组标题 + 下拉/工具行
  const personaOptions = [
    ...builtinPersonaList,
    ...customPersonaList.map((p) => ({ id: p.id, name: p.name ?? p.id })),
  ]
  children.push(createElement('div', { key: 'persona' },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '16px 0 8px' } },
      createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#888' } }, '人设台词'),
      headerLink('自定义人设 ↗', openPersonasFile),
    ),
    createElement('div', { style: rowStyle },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: personaNotice || personaState?.personasError ? 6 : 0 } },
        createElement(ThemeSelect, {
          value: activePersona,
          options: personaOptions,
          disabled: !writable,
          onChange: (id: string) => {
            enqueueWrite(() => [{ op: 'set', path: ['persona'], value: id }])
          },
        }),
        createElement('button', { style: buttonStyle, onClick: reloadPersonas }, '↻ 重新读取'),
      ),
      (personaState?.personasError || personaNotice) && createElement('div', {
        key: 'persona-notice',
        style: { color: personaState?.personasError ? '#b45309' : '#888', fontSize: 12 },
      },
        (personaState?.personasError ? `人设文件：${personaState.personasError}` : null) ?? personaNotice,
      ),
      showPersonaPopover && createElement('div', {
        key: 'persona-popover',
        style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(128,128,128,.12)', fontSize: 12, wordBreak: 'break-all' },
      },
        createElement('div', null, '无法直接打开，请手动编辑人设文件：'),
        createElement('div', { style: { margin: '4px 0', color: '#666' } }, personaState?.personasFile ?? ''),
        createElement('div', { style: { display: 'flex', gap: 6 } },
          createElement('button', {
            style: buttonStyle,
            onClick: () => { void copyText(personaState?.personasFile ?? '').then((ok) => setPersonaNotice(ok ? '已复制文件路径' : '复制失败')) },
          }, '复制路径'),
          createElement('button', {
            style: buttonStyle,
            onClick: () => { void copyText(PERSONAS_TEMPLATE).then((ok) => setPersonaNotice(ok ? '已复制人设模板（女仆示例）' : '复制失败')) },
          }, '复制模板'),
          createElement('button', { style: buttonStyle, onClick: () => setShowPersonaPopover(false) }, '收起'),
        ),
      ),
    ),
  ))

  // 5. 模型列表（自绘 radio，与帧率档共用 ThemeRadioDot）
  children.push(createElement('div', { key: 'models' },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '16px 0 8px' } },
      createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#888' } }, '内置模型（只读）'),
      !!value.developerMode && headerLink('打开配置文件 ↗', openBuiltinPresetsFile),
    ),
    (builtinFileNotice || showBuiltinFilePopover) && createElement('div', {
      key: 'builtin-file-notice',
      style: { marginBottom: 6, color: '#b45309', fontSize: 12 },
    },
      builtinFileNotice,
      showBuiltinFilePopover && createElement('div', { style: { marginTop: 4, wordBreak: 'break-all' } },
        '无法直接打开，文件路径：',
        createElement('div', { style: { color: '#666' } }, presetsPath),
        createElement('button', { style: { ...buttonStyle, marginLeft: 0, marginTop: 4 }, onClick: () => setShowBuiltinFilePopover(false) }, '收起'),
      ),
    ),
    createElement('div', { role: 'radiogroup', 'aria-label': '内置模型' },
      builtinRows.length > 0 ? builtinRows : createElement('div', { style: { color: '#888', fontSize: 12 } }, '清单加载中…'),
    ),
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '16px 0 8px' } },
      createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#888' } }, '我的模型'),
      headerLink('打开配置文件 ↗', openCustomModelsFile),
    ),
    (customFileNotice || showCustomFilePopover) && createElement('div', {
      key: 'custom-file-notice',
      style: { marginBottom: 6, color: '#b45309', fontSize: 12 },
    },
      customFileNotice,
      showCustomFilePopover && createElement('div', { style: { marginTop: 4, wordBreak: 'break-all' } },
        '无法直接打开，文件路径：',
        createElement('div', { style: { color: '#666' } }, customModelsPath),
        createElement('button', { style: { ...buttonStyle, marginLeft: 0, marginTop: 4 }, onClick: () => setShowCustomFilePopover(false) }, '收起'),
      ),
    ),
    createElement('div', { role: 'radiogroup', 'aria-label': '我的模型' },
      customRows.length > 0 ? customRows : createElement('div', { style: { color: '#888', fontSize: 12, marginBottom: 8 } }, '尚未添加自定义模型'),
    ),
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        createElement('input', {
          style: inputStyle,
          value: newName,
          placeholder: '名称',
          disabled: !writable,
          onChange: (e: ChangeEvent<HTMLInputElement>) => setNewName(e.target.value),
        }),
        createElement('input', {
          style: { ...inputStyle, flex: 1, minWidth: 140 },
          value: newUrl,
          placeholder: 'https://…/xxx.model3.json 或本地绝对路径（如 /home/…、C:/models/...）',
          disabled: !writable,
          onChange: (e: ChangeEvent<HTMLInputElement>) => setNewUrl(e.target.value),
        }),
        createElement('button', {
          type: 'button',
          style: buttonStyle,
          disabled: !writable,
          onClick: () => setBrowseTarget('new'),
        }, '选择本地文件'),
        createElement('button', { style: buttonStyle, onClick: addModel, disabled: !writable }, '添加'),
      ),
      newFormNotice && createElement('div', {
        key: 'new-form-notice',
        style: { color: '#b45309', fontSize: 12 },
      }, newFormNotice),
      createElement('div', { key: 'new-panel-tabs', style: { display: 'flex', gap: 4 } },
        createElement('button', {
          type: 'button',
          style: activeNewPanel === 'spatial' ? panelTabActiveStyle : panelTabStyle,
          disabled: !writable,
          onClick: () => setActiveNewPanel((v) => v === 'spatial' ? null : 'spatial'),
        }, '空间分区覆盖'),
        createElement('button', {
          type: 'button',
          style: activeNewPanel === 'motion' ? panelTabActiveStyle : panelTabStyle,
          disabled: !writable,
          onClick: () => setActiveNewPanel((v) => v === 'motion' ? null : 'motion'),
        }, '动画映射'),
      ),
      activeNewPanel === 'spatial' && createElement('div', { key: 'new-spatial' },
        createElement('div', { style: { fontSize: 11, color: '#888', marginBottom: 4 } },
          '相对包围盒 0–1；留空=该字段用全局默认。适合大帽子/全身比例与默认差较多的模型。'),
        spatialTapFields(newSpatial, setNewSpatial, !writable),
      ),
      activeNewPanel === 'motion' && createElement('div', { key: 'new-motion' },
        createElement('div', { style: { fontSize: 11, color: '#888', marginBottom: 4 } },
          '按状态/互动部位配置模型动作组；未配置项沿用默认。'),
        motionMapFields(newMotionMap, setNewMotionMap, newMotionGroups, newMotionStatus, !writable, () => {
          setActiveNewPanel(null)
          requestAnimationFrame(() => setActiveNewPanel('motion'))
        }),
      ),
    ),
  ))

  // 6. 开发者选项：组标题 + 右侧 switch；开启后显示调试面板 / 点击分区
  children.push(createElement('div', { key: 'devtools' },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '16px 0 8px' } },
      createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#888' } }, '开发者选项'),
      createElement(ThemeSwitch, {
        checked: !!value.developerMode,
        disabled: !writable,
        onChange: (next) => {
          enqueueWrite(() => [{ op: 'set', path: ['developerMode'], value: next }])
        },
      }),
    ),
    !!value.developerMode && createElement('div', { style: rowStyle },
      createElement('label', { style: labelStyle },
        createElement('input', {
          type: 'checkbox',
          checked: !!value.debug,
          disabled: !writable,
          onChange: (e: ChangeEvent<HTMLInputElement>) => {
            const next = e.target.checked
            enqueueWrite(() => [{ op: 'set', path: ['debug'], value: next }])
          },
        }),
        createElement('span', null, '调试面板'),
      ),
      createElement('label', { style: { ...labelStyle, marginTop: 8 } },
        createElement('input', {
          type: 'checkbox',
          checked: !!value.showTapZones,
          disabled: !writable,
          onChange: (e: ChangeEvent<HTMLInputElement>) => {
            const next = e.target.checked
            enqueueWrite(() => [{ op: 'set', path: ['showTapZones'], value: next }])
          },
        }),
        createElement('span', null, '显示点击分区（空间回退色块）'),
      ),
    ),
  ))

  // 「选择本地文件」弹层：选中后回填到对应的 URL 框（新增 / 编辑）
  if (browseTarget) {
    children.push(createElement(LocalFileBrowser, {
      key: 'local-file-browser',
      onPick: (p: string) => {
        if (browseTarget === 'edit') setEditUrl(p)
        else setNewUrl(p)
        setBrowseTarget(null)
      },
      onClose: () => setBrowseTarget(null),
    }))
  }

  return createElement('div', { style: { padding: '16px 20px', maxWidth: 560 } }, children)
}
