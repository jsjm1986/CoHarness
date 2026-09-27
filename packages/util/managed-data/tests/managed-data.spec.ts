/** Inventory claims survive changed roots and reject unreadable ownership evidence. */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { readManagedDataPaths, registerManagedDataPath, type ManagedDataPath } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-data-inventory-'))
  roots.push(root)
  return { root, file: join(root, 'private', 'managed-data.jsonl') }
}

it('keeps old and new storage roots without growing on unchanged registration', () => {
  const { root, file } = fixture()
  const entry: ManagedDataPath = { owner: 'reviews', kind: 'directory', path: join(root, 'old-reviews') }
  registerManagedDataPath(entry, undefined)
  expect(() => readManagedDataPaths(file)).toThrow()
  registerManagedDataPath(entry, file)
  const original = readFileSync(file, 'utf8')
  registerManagedDataPath(entry, file)
  expect(readFileSync(file, 'utf8')).toBe(original)
  const changed = { ...entry, path: join(root, 'new-reviews') }
  registerManagedDataPath(changed, file)
  registerManagedDataPath({ ...entry, owner: 'other-owner' }, file)
  registerManagedDataPath({ owner: 'settings', kind: 'file', path: join(root, 'settings.yaml') }, file)
  expect(readManagedDataPaths(file)).toEqual([
    changed, { ...entry, owner: 'other-owner' }, entry,
    { owner: 'settings', kind: 'file', path: join(root, 'settings.yaml') },
  ])
  expect(() => { registerManagedDataPath(entry, 'relative-inventory') }).toThrow('absolute')
})

it.each(['null', '[]', '{}', '{"version":2}', '{"version":1,"owner":"x","kind":"file","path":"relative"}'])(
  'refuses malformed inventory %s before adding another claim', (record) => {
    const { root } = fixture(), file = join(root, 'manifest')
    writeFileSync(file, record + '\n')
    expect(() => { registerManagedDataPath({ owner: 'new', kind: 'file', path: join(root, 'value') }, file) }).toThrow('Invalid managed-data')
    expect(readFileSync(file, 'utf8')).toBe(record + '\n')
  },
)

it('refuses incomplete and link-shaped inventories without replacing their original bytes', () => {
  const { root } = fixture(), file = join(root, 'manifest')
  writeFileSync(file, '{"version":1')
  expect(() => readManagedDataPaths(file)).toThrow('incomplete')
  const link = join(root, 'link')
  symlinkSync(file, link)
  expect(() => readManagedDataPaths(link)).toThrow('regular file')
  expect(() => { registerManagedDataPath({ owner: 'x', kind: 'file', path: join(root, 'value') }, link) }).toThrow('regular file')
  expect(readFileSync(file, 'utf8')).toBe('{"version":1')
})

it('refuses an oversized existing inventory and refuses an append that would exceed its readable size', () => {
  const { root } = fixture(), file = join(root, 'manifest'), limit = 16 * 1024 * 1024
  const line = JSON.stringify({ version: 1, owner: 'old', kind: 'file', path: join(root, 'old') }) + '\n'
  writeFileSync(file, ' '.repeat(limit - Buffer.byteLength(line)) + line)
  const entry: ManagedDataPath = { owner: 'new', kind: 'file', path: join(root, 'new') }
  expect(() => { registerManagedDataPath(entry, file) }).toThrow('exceeds')
  expect(fs.statSync(file).size).toBe(limit)
  fs.truncateSync(file, limit + 1)
  expect(() => readManagedDataPaths(file)).toThrow('exceeds')
})

it('does not append into a replacement file swapped in after inventory validation', () => {
  const { root, file } = fixture()
  registerManagedDataPath({ owner: 'old', kind: 'file', path: join(root, 'old') }, file)
  const original = readFileSync(file, 'utf8'), open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (path === file && flags === 'a') {
      fs.renameSync(file, file + '.original')
      writeFileSync(file, original)
    }
    return open(path, flags, mode)
  })
  syncBuiltinESMExports()
  expect(() => { registerManagedDataPath({ owner: 'new', kind: 'file', path: join(root, 'new') }, file) })
    .toThrow('changed during registration')
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(readFileSync(file + '.original', 'utf8')).toBe(original)
})

it('rejects a replacement inode before reading its ownership claims', () => {
  const { root, file } = fixture()
  registerManagedDataPath({ owner: 'old', kind: 'file', path: join(root, 'old') }, file)
  const original = readFileSync(file, 'utf8'), open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (path === file && typeof flags === 'number') {
      fs.renameSync(file, file + '.original')
      writeFileSync(file, original)
    }
    return open(path, flags, mode)
  })
  syncBuiltinESMExports()
  expect(() => readManagedDataPaths(file)).toThrow('changed during read')
  expect(readFileSync(file + '.original', 'utf8')).toBe(original)
})

it('keeps reads bounded if an inventory grows after its initial size check', () => {
  const { root, file } = fixture()
  registerManagedDataPath({ owner: 'old', kind: 'file', path: join(root, 'old') }, file)
  const open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (path === file && typeof flags === 'number') fs.truncateSync(file, 16 * 1024 * 1024 + 1)
    return open(path, flags, mode)
  })
  syncBuiltinESMExports()
  expect(() => readManagedDataPaths(file)).toThrow('exceeds its readable size')
})
