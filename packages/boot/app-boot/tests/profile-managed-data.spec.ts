/** Profile metadata is registered before any initialization, normalization or write. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readManagedDataPaths } from '@deepseek-ai/dsh-managed-data'
import { initProfile, loadProfile, loadProfileDirectory, writeProfileManifest } from '../src/profile.ts'

const owned: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-inventory-'))
  owned.push(root)
  const home = join(root, 'home'), dir = join(home, 'profiles', 'custom'), inventory = join(root, 'managed-data.jsonl')
  vi.stubEnv('DSH_MANAGED_DATA_MANIFEST', undefined)
  return { root, home, dir, inventory, anchor: join(root, 'app', 'package.json') }
}

it('registers exactly the four profile declarations and leaves generated dependencies unclaimed', () => {
  const f = fixture()
  vi.stubEnv('DSH_MANAGED_DATA_MANIFEST', f.inventory)
  initProfile(f.dir, [])
  expect(readManagedDataPaths(f.inventory)).toEqual([
    'cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  ].map(name => ({ owner: 'app-boot', kind: 'file', path: join(f.dir, name) })))
  const first = readFileSync(f.inventory, 'utf8')
  initProfile(f.dir, [])
  writeProfileManifest(f.dir, { name: 'changed', dsh: { profile: { bundles: [] } } })
  expect(loadProfileDirectory('fixture', f.dir, f.anchor).layers).toEqual([])
  expect(readFileSync(f.inventory, 'utf8')).toBe(first)
  expect(JSON.parse(readFileSync(join(f.dir, 'package.json'), 'utf8'))).toMatchObject({ name: 'changed' })
})

it('registers an already initialized profile when it is loaded', () => {
  const f = fixture()
  initProfile(f.dir, [])
  expect(existsSync(f.inventory)).toBe(false)
  vi.stubEnv('DSH_MANAGED_DATA_MANIFEST', f.inventory)
  loadProfile('fixture', 'custom', f.anchor, f.home)
  expect(readManagedDataPaths(f.inventory)).toHaveLength(4)
})

it('refuses a damaged inventory before creating any profile file or directory', () => {
  const f = fixture(), corrupt = 'null\n'
  writeFileSync(f.inventory, corrupt)
  vi.stubEnv('DSH_MANAGED_DATA_MANIFEST', f.inventory)
  expect(() => { initProfile(f.dir, []) }).toThrow('Invalid managed-data inventory')
  expect(existsSync(f.dir)).toBe(false)
  expect(readFileSync(f.inventory, 'utf8')).toBe(corrupt)
})

it('preserves existing profile bytes when inventory rejection prevents a write or load', () => {
  const f = fixture()
  initProfile(f.dir, [])
  const before = readFileSync(join(f.dir, 'package.json'), 'utf8')
  writeFileSync(f.inventory, 'null\n')
  vi.stubEnv('DSH_MANAGED_DATA_MANIFEST', f.inventory)
  expect(() => { writeProfileManifest(f.dir, { name: 'rejected' }) }).toThrow('Invalid managed-data inventory')
  expect(() => loadProfileDirectory('fixture', f.dir, f.anchor)).toThrow('Invalid managed-data inventory')
  expect(readFileSync(join(f.dir, 'package.json'), 'utf8')).toBe(before)
})

it('refuses inventory corruption before rewriting an installation-owned legacy profile', () => {
  const f = fixture(), dir = join(f.home, 'profiles', 'headless')
  mkdirSync(dir, { recursive: true })
  const before = JSON.stringify({ dsh: { profile: { bundles: [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
  ] } } }) + '\n'
  writeFileSync(join(dir, 'package.json'), before)
  writeFileSync(f.inventory, 'null\n')
  vi.stubEnv('DSH_MANAGED_DATA_MANIFEST', f.inventory)
  expect(() => loadProfile('fixture', 'headless', f.anchor, f.home)).toThrow('Invalid managed-data inventory')
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
})
