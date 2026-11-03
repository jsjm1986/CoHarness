/** Personal Runtime data stays private while account working directories retain their existing ownership. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { personalRuntimeLayout } from '../src/runtime-layout.ts'
import { prepareUserData } from '../src/user-data.ts'
import { testConfig } from './test-config.ts'
import { USERNAME_RE } from '../src/user-name.ts'
import { unitName } from '../src/systemd.ts'

const releases: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-runtime-layout-'))
  releases.push(() => rm(root, { recursive: true, force: true }))
  return { root, cfg: testConfig(root) }
}

describe('personal Runtime storage', () => {
  it('preserves released data and creates separate settings and Session directories for additional assignments', async () => {
    const { cfg } = await fixture(), username = 'member'
    prepareUserData(cfg, username)
    const original = personalRuntimeLayout(cfg, { username })
    await writeFile(join(original.dshHome, 'settings.yaml'), 'personal: original\n')
    const storage = { runtimeId: randomUUID() as RuntimeId, storageLayout: 'isolated' as const }
    prepareUserData(cfg, username, storage)
    const added = personalRuntimeLayout(cfg, { username, ...storage })
    await writeFile(join(added.dshHome, 'settings.yaml'), 'personal: additional\n')
    prepareUserData(cfg, username, storage)
    expect(original).toEqual({ runtimeKey: username, dshHome: join(cfg.usersRoot, username, 'dsh') })
    expect(added.runtimeKey).not.toBe(original.runtimeKey)
    expect(USERNAME_RE.test(added.runtimeKey)).toBe(false)
    expect(() => unitName(added.runtimeKey, 1, 'a'.repeat(64))).not.toThrow()
    expect(await readFile(join(original.dshHome, 'settings.yaml'), 'utf8')).toBe('personal: original\n')
    expect(await readFile(join(added.dshHome, 'settings.yaml'), 'utf8')).toBe('personal: additional\n')
    for (const layout of [original, added]) {
      expect(await readFile(join(layout.dshHome, 'managed-data.jsonl'), 'utf8')).toContain(join(cfg.usersRoot, username, 'home', 'documents'))
    }
  })

  it('refuses an aliased Runtime directory before creating another assignment data', async () => {
    const { cfg, root } = await fixture(), username = 'member'
    prepareUserData(cfg, username)
    await symlink(root, join(cfg.usersRoot, username, 'runtimes'))
    expect(() => prepareUserData(cfg, username, { runtimeId: randomUUID() as RuntimeId, storageLayout: 'isolated' }))
      .toThrow('user data directory must not be a link or file')
  })
})
