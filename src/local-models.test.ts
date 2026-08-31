import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  localModelTarget,
  localModelUrlPath,
  resolveLocalModelFile,
  resolveLocalEntryFile,
  expandLocalPath,
  listLocalDir,
} from './local-models.ts'
import { isLocalModelPath, isSupportedModelLocation } from './models.ts'

describe('local model path helpers', () => {
  it('识别本地路径与远程 URL', () => {
    expect(isLocalModelPath('C:/models/foo.model3.json')).toBe(true)
    expect(isLocalModelPath('C:\\models\\foo.model3.json')).toBe(true)
    expect(isLocalModelPath('/home/user/model.model3.json')).toBe(true)
    expect(isLocalModelPath('~/models/foo.model3.json')).toBe(true)
    expect(isLocalModelPath('https://example.com/model.model3.json')).toBe(false)
    expect(isSupportedModelLocation('C:/models/foo.model3.json')).toBe(true)
    expect(isSupportedModelLocation('https://example.com/model.model3.json')).toBe(true)
    expect(isSupportedModelLocation('~/models/foo.model3.json')).toBe(true)
    expect(isSupportedModelLocation('relative/path.model3.json')).toBe(false)
  })

  it('expandLocalPath 展开 ~ 为家目录，其余原样', () => {
    const home = expandLocalPath('~')
    expect(home).toBeTruthy()
    expect(home.startsWith('/')).toBe(true)
    expect(expandLocalPath('~/a/b.model3.json')).toBe(join(home, 'a', 'b.model3.json'))
    expect(expandLocalPath('/abs/path.model3.json')).toBe('/abs/path.model3.json')
    expect(expandLocalPath('C:/models/foo.model3.json')).toBe('C:/models/foo.model3.json')
  })

  it('文件路径解析出目录与入口文件名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-l2d-local-'))
    try {
      const model = join(dir, 'foo.model3.json')
      writeFileSync(model, '{}', 'utf8')
      const target = localModelTarget(model)
      expect(target?.fileName).toBe('foo.model3.json')
      expect(target?.root).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录路径自动找到第一个 .model3.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-l2d-local-dir-'))
    try {
      writeFileSync(join(dir, 'a.model3.json'), '{}', 'utf8')
      writeFileSync(join(dir, 'b.model3.json'), '{}', 'utf8')
      const target = localModelTarget(dir)
      expect(target?.root).toBe(dir)
      expect(['a.model3.json', 'b.model3.json']).toContain(target?.fileName)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveLocalModelFile 允许目录内访问，拒绝路径穿越', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-l2d-local-safe-'))
    try {
      const model = join(dir, 'foo.model3.json')
      const secret = join(dir, 'secret.txt')
      writeFileSync(model, '{}', 'utf8')
      writeFileSync(secret, 'secret', 'utf8')
      expect(resolveLocalModelFile(model, 'foo.model3.json')).toBe(model)
      expect(resolveLocalModelFile(model, 'secret.txt')).toBe(secret)
      expect(resolveLocalModelFile(model, '../outside.txt')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('localModelUrlPath 生成同源虚拟 URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-l2d-local-url-'))
    try {
      const model = join(dir, 'foo.model3.json')
      writeFileSync(model, '{}', 'utf8')
      expect(localModelUrlPath('m1', model)).toBe(`/pet-local-models/m1/foo.model3.json`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveLocalEntryFile 文件/目录均可解析出入口文件，无入口返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-l2d-local-entry-'))
    try {
      const a = join(dir, 'a.model3.json')
      writeFileSync(a, '{}', 'utf8')
      // 文件路径 → 原样返回
      expect(resolveLocalEntryFile(a)).toBe(resolve(a))
      // 目录路径 → 目录内第一个 .model3.json
      expect(resolveLocalEntryFile(dir)).toBe(resolve(dir, 'a.model3.json'))
      // 无 .model3.json 的目录 → null
      const empty = join(dir, 'empty')
      mkdirSync(empty)
      expect(resolveLocalEntryFile(empty)).toBeNull()
      // 非法位置 → null
      expect(resolveLocalEntryFile('relative/x.model3.json')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('listLocalDir 列出子目录与 .model3.json 文件，跳过其它文件与损坏条目', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-l2d-local-list-'))
    try {
      const sub = join(dir, 'sub')
      mkdirSync(sub)
      writeFileSync(join(dir, 'a.model3.json'), '{}', 'utf8')
      writeFileSync(join(dir, 'b.model3.json'), '{}', 'utf8')
      writeFileSync(join(dir, 'note.txt'), 'x', 'utf8')
      const listing = listLocalDir(dir)
      expect(listing).not.toBeNull()
      expect(listing!.path).toBe(dir)
      expect(listing!.files.map((f) => f.name).sort()).toEqual(['a.model3.json', 'b.model3.json'])
      expect(listing!.dirs.map((d) => d.name)).toEqual(['sub'])
      expect(listing!.parent).toBe(resolve(dir, '..'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('listLocalDir 目标不存在或非目录返回 null', () => {
    expect(listLocalDir('/no/such/dir-xyz')).toBeNull()
  })
})
