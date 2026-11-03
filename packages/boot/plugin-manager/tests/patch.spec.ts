/** Profile patch edits preserve user-authored syntax and are idempotent. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { writePluginConfig, writePluginEnabled } from '../src/patch.ts'

async function fixture(text?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'manager-patch-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'cordis.patch.yml')
  if (text !== undefined) await writeFile(file, text)
  return file
}

it('preserves comments, expressions, unrelated configuration and the last override', async () => {
  const file = await fixture('# personal configuration\n- id: tool\n  config:\n    value: !!js process.platform\n- id: tool\n  disabled: false # availability\n')
  expect(await writePluginEnabled(file, 'tool', 'package', false)).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('# personal configuration')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  expect(loadOptionalPatches('test', file)).toEqual([
    { id: 'tool', config: { value: { __jsExpr: 'process.platform' } } }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(file, 'tool', 'package', false)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(text)
  expect(await writePluginEnabled(file, 'tool', 'package', true)).toBe(true)
})

it('creates a missing patch file and appends after insertions', async () => {
  const file = await fixture()
  await writePluginEnabled(file, 'tool', 'package', false)
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'tool', disabled: true }])
  await writeFile(file, '- insert:\n    - id: tool\n      name: package\n')
  await writePluginEnabled(file, 'tool', 'package', true)
  expect(loadOptionalPatches('test', file)).toEqual([
    { insert: [{ id: 'tool', name: 'package' }] }, { id: 'tool', disabled: false },
  ])
})

it.each(['- id: [broken', 'mapping: true\n'])('refuses malformed documents without overwriting %s', async (text) => {
  const file = await fixture(text)
  await expect(writePluginEnabled(file, 'tool', 'package', true)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe(text)
})


it('retains name-asserting overrides and appends an unambiguous switch', async () => {
  const file = await fixture('- id: tool\n  name: another-package\n  disabled: false\n')
  await writePluginEnabled(file, 'tool', 'package', false)
  expect(loadOptionalPatches('test', file)).toEqual([
    { id: 'tool', name: 'another-package', disabled: false }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(file, 'tool', 'package', false)).toBe(false)
})

it('reports read failures without replacing a directory with configuration', async () => {
  const file = await fixture()
  await mkdir(file)
  await expect(writePluginEnabled(file, 'tool', 'package', true)).rejects.toThrow()
})

it('updates the last matching named override and leaves mismatched names untouched', async () => {
  const file = await fixture('- id: tool\n  disabled: true\n- id: tool\n  name: package\n  config:\n    value: !!js process.platform\n  disabled: true # availability\n- id: tool\n  name: another-package\n  disabled: true\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true)).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  const patches = loadOptionalPatches('test', file)
  expect(patches).toEqual([
    { id: 'tool', disabled: true },
    { id: 'tool', name: 'package', config: { value: { __jsExpr: 'process.platform' } }, disabled: false },
    { id: 'tool', name: 'another-package', disabled: true },
  ])
  expect(applyEntryPatches([{ id: 'tool', name: 'package' }], patches, () => {}))
    .toMatchObject([{ id: 'tool', name: 'package', disabled: false }])
  expect(await writePluginEnabled(file, 'tool', 'package', true)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(text)
  expect(await writePluginEnabled(file, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', file)).toHaveLength(3)
})

it('replaces the effective config without merging old fields or changing other profile settings', async () => {
  const file = await fixture('# personal configuration\n- id: other\n  config:\n    value: !!js process.platform\n- id: tool\n  config:\n    stale: true\n- id: tool\n  name: package\n  config:\n    previous: true\n  disabled: true # availability\n- id: tool\n  name: another-package\n  config:\n    untouched: true\n')
  expect(await writePluginConfig(file, 'tool', 'package', { current: 'saved' })).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('# personal configuration')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  const patches = loadOptionalPatches('test', file)
  expect(patches?.at(-1)).toEqual({ id: 'tool', name: 'another-package', config: { untouched: true } })
  expect(applyEntryPatches([{ id: 'tool', name: 'package', config: { default: true } }], patches, () => {}))
    .toEqual([{ id: 'tool', name: 'package', config: { current: 'saved' }, disabled: true }])
})

it('creates and clears a named config override while retaining composition defaults', async () => {
  const file = await fixture()
  expect(await writePluginConfig(file, 'tool', 'package', null)).toBe(false)
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await writePluginConfig(file, 'tool', 'package', { custom: true })).toBe(true)
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'tool', name: 'package', config: { custom: true } }])
  expect(await writePluginConfig(file, 'tool', 'package', null)).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(applyEntryPatches([{ id: 'tool', name: 'package', config: { default: true } }], loadOptionalPatches('test', file), () => {}))
    .toEqual([{ id: 'tool', name: 'package', config: { default: true } }])
  expect(await writePluginConfig(file, 'tool', 'package', null)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(text)
})

it('clears all applicable overrides instead of restoring an older override after a reset', async () => {
  const file = await fixture('- insert:\n    - id: tool\n      name: package\n      config:\n        default: true\n- id: tool\n  config:\n    stale: true\n  disabled: true # availability\n- id: tool\n  name: package\n  config:\n    current: true\n- id: tool\n  name: another-package\n  config:\n    untouched: true\n')
  expect(await writePluginConfig(file, 'tool', 'package', null)).toBe(true)
  const patches = loadOptionalPatches('test', file)
  expect(patches).toEqual([
    { insert: [{ id: 'tool', name: 'package', config: { default: true } }] },
    { id: 'tool', disabled: true },
    { id: 'tool', name: 'another-package', config: { untouched: true } },
  ])
  expect(applyEntryPatches([], patches, () => {})).toEqual([
    { id: 'tool', name: 'package', config: { default: true }, disabled: true },
  ])
  expect(await readFile(file, 'utf8')).toContain('# availability')
})

it('leaves a config-free matching row untouched when no override needs clearing', async () => {
  const original = '- id: tool\n  name: package\n  disabled: true # availability\n'
  const file = await fixture(original)
  expect(await writePluginConfig(file, 'tool', 'package', null)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(original)
})

it('appends a config override after insertions and mismatched names', async () => {
  const file = await fixture('- insert:\n    - id: tool\n      name: package\n- id: tool\n  name: another-package\n  config:\n    untouched: true\n')
  expect(await writePluginConfig(file, 'tool', 'package', { current: true })).toBe(true)
  expect(applyEntryPatches([], loadOptionalPatches('test', file), () => {}))
    .toEqual([{ id: 'tool', name: 'package', config: { current: true } }])
})

it.each(['- id: [broken', 'mapping: true\n'])('refuses a malformed config patch without overwriting %s', async (text) => {
  const file = await fixture(text)
  await expect(writePluginConfig(file, 'tool', 'package', {})).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe(text)
})

it('reports config read failures without replacing a directory', async () => {
  const file = await fixture()
  await mkdir(file)
  await expect(writePluginConfig(file, 'tool', 'package', {})).rejects.toThrow()
})
