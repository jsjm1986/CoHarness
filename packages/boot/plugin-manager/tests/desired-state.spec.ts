/** Desired-state file protocol: managed-row detection, preservation, and round-trips. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import { initProfile, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { applyDesiredState, readDesiredState } from '../src/desired-state.ts'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function profile(rows: unknown[] | undefined = [], bundles = ['core', 'extra']) {
  const home = mkdtempSync(join(tmpdir(), 'desired-state-'))
  homes.push(home)
  const dir = join(home, 'profiles', 'web')
  initProfile(dir, bundles)
  const patchPath = join(dir, 'cordis.patch.yml')
  if (rows !== undefined) writeFileSync(patchPath, JSON.stringify(rows))
  return { dir, patchPath }
}

it('reads managed rows and the bundle selection, skipping hand-authored declarations', async () => {
  const { dir, patchPath } = profile([
    { id: 'managed', name: './plugin.mjs', disabled: true },
    { id: 'forced', disabled: false },
    { id: 'hand-authored', name: './custom.mjs', config: { note: 'keep me' } },
    { insert: [{ id: 'x' }] },
    'not-an-object',
    { id: 5, disabled: true },
    { id: 'untyped-disabled' },
  ])
  expect(await readDesiredState(dir, patchPath)).toEqual({
    entries: [
      { id: 'managed', name: './plugin.mjs', disabled: true },
      { id: 'forced', disabled: false },
    ],
    bundles: ['core', 'extra'],
  })
})

it('replaces managed rows and the bundle selection while preserving other declarations', async () => {
  const { dir, patchPath } = profile([
    { id: 'old-managed', disabled: true },
    { id: 'hand-authored', name: './custom.mjs', config: { note: 'keep me' } },
  ])
  await applyDesiredState(dir, patchPath, {
    entries: [{ id: 'new-managed', name: './plugin.mjs', disabled: false }],
    bundles: ['extra'],
  })
  expect(parse(readFileSync(patchPath, 'utf8'))).toEqual([
    { id: 'hand-authored', name: './custom.mjs', config: { note: 'keep me' } },
    { id: 'new-managed', name: './plugin.mjs', disabled: false },
  ])
  const manifest = readProfileManifest('web', dir)
  expect(manifest.dsh?.profile?.bundles).toEqual(['extra'])
  expect(manifest.dependencies).toBeDefined()
})

it('round-trips a saved composition through the files', async () => {
  const { dir, patchPath } = profile()
  const state = {
    entries: [{ id: 'a', disabled: true }, { id: 'b', name: './b.mjs', disabled: false }],
    bundles: ['extra', 'core'],
  }
  await applyDesiredState(dir, patchPath, state)
  expect(await readDesiredState(dir, patchPath)).toEqual(state)
})

it('reads an absent patch file as empty rows', async () => {
  const { dir, patchPath } = profile(undefined)
  expect(await readDesiredState(dir, patchPath)).toEqual({ entries: [], bundles: ['core', 'extra'] })
  await applyDesiredState(dir, patchPath, { entries: [{ id: 'a', disabled: true }], bundles: [] })
  expect(await readDesiredState(dir, patchPath)).toEqual({ entries: [{ id: 'a', disabled: true }], bundles: [] })
})
