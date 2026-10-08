/** Pending script permissions survive cleanup and preserve unrelated workspace settings. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { parse } from 'yaml'
import { approveBuilds, capturePendingBuilds, readPendingBuilds } from '../src/build-approval.ts'

function fixture(text?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'build-approval-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const filename = join(dir, 'pnpm-workspace.yaml')
  if (text !== undefined) writeFileSync(filename, text)
  return { dir, filename }
}

it('approves only named pending packages and preserves comments, decisions and settings', async () => {
  const { dir, filename } = fixture('# profile settings\nother: &unrelated value\ncopy: *unrelated\nnodeLinker: hoisted\nallowBuilds:\n  native: set this to true or false\n  "@scope/other": set this to true or false\n  trusted: true\n  denied: false\n  "@scope/*": set this to true or false\n')
  expect(await readPendingBuilds(dir)).toEqual(['native', '@scope/other'])
  await approveBuilds(dir, ['native'])
  const text = readFileSync(filename, 'utf8')
  expect(text).toContain('# profile settings')
  expect(parse(text)).toMatchObject({ nodeLinker: 'hoisted', allowBuilds: { native: true, trusted: true, denied: false } })
  expect(await readPendingBuilds(dir)).toEqual(['@scope/other'])
})

it.each(['missing', 'denied', '*', '--all'])('rejects an unlisted approval atomically: %s', async (name) => {
  const original = 'allowBuilds:\n  native: set this to true or false\n  denied: false\n'
  const { dir, filename } = fixture(original)
  await expect(approveBuilds(dir, ['native', name])).rejects.toThrow('stale-approval')
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('preserves pnpm file dependency selectors verbatim', async () => {
  const name = '@scope/addon@file:../local addon'
  const { dir, filename } = fixture(`allowBuilds:\n  '${name}': set this to true or false\n`)
  expect(await readPendingBuilds(dir)).toEqual([name])
  await approveBuilds(dir, [name])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({ allowBuilds: { [name]: true } })
})

it.each([undefined, '{}\n', 'nodeLinker: hoisted\n', 'allowBuilds: {}\n'])('has no pending approval without pnpm placeholders: %s', async (text) => {
  const { dir } = fixture(text)
  expect(await readPendingBuilds(dir)).toEqual([])
  await approveBuilds(dir, [])
})

it.each(['[', '[]\n', 'allowBuilds: false\n'])('rejects malformed workspace settings without rewriting them: %s', async (text) => {
  const { dir, filename } = fixture(text)
  await expect(readPendingBuilds(dir)).rejects.toThrow()
  await expect(approveBuilds(dir, ['native'])).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(text)
})

it('reports unreadable workspace settings', async () => {
  const { dir, filename } = fixture()
  mkdirSync(filename)
  await expect(readPendingBuilds(dir)).rejects.toThrow()
})

/** Write a real-shape `node_modules/.modules.yaml` holding the given ignored builds. */
function modulesManifest(dir: string, ignoredBuilds: string[]): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.modules.yaml'),
    `storeDir: /store/v11\nignoredBuilds:\n${ignoredBuilds.map(id => `  - "${id.replaceAll('"', '\\"')}"\n`).join('')}pendingBuilds: []\n`)
}

it('captures undecided ignored builds into policy and survives node_modules removal', async () => {
  const { dir, filename } = fixture('allowBuilds:\n  decided: true\n')
  modulesManifest(dir, ['native@1.2.3', '@scope/pkg@1.0.0', '@scope/addon@file:../local addon', 'native@1.2.3'])
  expect(await capturePendingBuilds(dir)).toEqual(['native', '@scope/pkg', '@scope/addon@file:../local addon'])
  const policy = parse(readFileSync(filename, 'utf8')) as { allowBuilds: Record<string, unknown> }
  expect(policy.allowBuilds).toEqual({
    decided: true,
    native: 'set this to true or false',
    '@scope/pkg': 'set this to true or false',
    '@scope/addon@file:../local addon': 'set this to true or false',
  })
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
  expect(await readPendingBuilds(dir)).toEqual(['native', '@scope/pkg', '@scope/addon@file:../local addon'])
  await approveBuilds(dir, ['native'])
  const after = parse(readFileSync(filename, 'utf8')) as { allowBuilds: Record<string, unknown> }
  expect(after.allowBuilds.native).toBe(true)
})

it('does not capture builds an existing decision covers', async () => {
  const { dir, filename } = fixture('allowBuilds:\n  denied: false\n  "vendored@9.9.9": false\n  trusted: true\n  "@scope/addon@file:../local addon": false\n')
  const original = readFileSync(filename, 'utf8')
  modulesManifest(dir, ['denied@2.0.0', 'vendored@9.9.9', 'trusted@4.0.0', '@scope/addon@file:../local addon'])
  expect(await capturePendingBuilds(dir)).toEqual([])
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('does not widen a denied file-source package by its bare name', async () => {
  const { dir } = fixture('allowBuilds:\n  "@scope/addon@file:../local addon": false\n')
  modulesManifest(dir, ['@scope/addon@file:../local addon'])
  expect(await capturePendingBuilds(dir)).toEqual([])
})

it('merges captured names with pre-existing placeholders without churn', async () => {
  const original = 'allowBuilds:\n  native: set this to true or false\n'
  const { dir, filename } = fixture(original)
  modulesManifest(dir, ['native@1.2.3', 'fresh@0.1.0'])
  expect(await capturePendingBuilds(dir)).toEqual(['native', 'fresh'])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({
    allowBuilds: { native: 'set this to true or false', fresh: 'set this to true or false' },
  })
})

it('treats a missing modules manifest as no pending builds and never rewrites policy', async () => {
  const original = 'allowBuilds:\n  native: set this to true or false\n'
  const { dir, filename } = fixture(original)
  expect(await capturePendingBuilds(dir)).toEqual(['native'])
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it.each([
  ['malformed YAML', '['],
  ['a non-mapping manifest', '[]\n'],
  ['a non-sequence ignoredBuilds', 'ignoredBuilds: native@1.2.3\n'],
  ['non-string ignored entries', 'ignoredBuilds:\n  - 42\n'],
])('rejects %s in node_modules/.modules.yaml without touching policy', async (_label, manifest) => {
  const original = 'allowBuilds:\n  native: set this to true or false\n'
  const { dir, filename } = fixture(original)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.modules.yaml'), manifest)
  await expect(capturePendingBuilds(dir)).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('creates the exact pending entry when the workspace has no allowBuilds policy', async () => {
  const { dir, filename } = fixture('nodeLinker: hoisted\n')
  modulesManifest(dir, ['added@2.0.0'])
  expect(await capturePendingBuilds(dir)).toEqual(['added'])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({
    nodeLinker: 'hoisted', allowBuilds: { added: 'set this to true or false' },
  })
})

it('writes nothing for a modules manifest without ignoredBuilds', async () => {
  const original = 'nodeLinker: hoisted\n'
  const { dir, filename } = fixture(original)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.modules.yaml'), 'storeDir: /store/v11\npendingBuilds: []\n')
  expect(await capturePendingBuilds(dir)).toEqual([])
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it.each(['an empty ignored value', 'a non-string ignored value'])('rejects %s without a policy write', async (entry) => {
  const original = 'allowBuilds:\n  kept: false\n'
  const { dir, filename } = fixture(original)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const item = entry === 'a non-string ignored value' ? '42' : '""'
  writeFileSync(join(dir, 'node_modules', '.modules.yaml'), `ignoredBuilds:\n  - ${item}\n`)
  await expect(capturePendingBuilds(dir)).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('rejects an unreadable module manifest without a policy write', async () => {
  const original = 'allowBuilds:\n  kept: false\n'
  const { dir, filename } = fixture(original)
  mkdirSync(join(dir, 'node_modules', '.modules.yaml'), { recursive: true })
  await expect(capturePendingBuilds(dir)).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it.each([
  ['allowBuilds:\n  named: [seq]\n'],
  ['allowBuilds:\n  [k]: false\n'],
])('rejects an invalid allowBuilds rule even with no ignored builds: %s', async (policy) => {
  const { dir, filename } = fixture(policy)
  await expect(capturePendingBuilds(dir)).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(policy)
})

it('rejects approval after a manual denial without mutating the policy', async () => {
  const { dir, filename } = fixture('allowBuilds:\n  decided: true\n')
  modulesManifest(dir, ['native@1.2.3'])
  expect(await capturePendingBuilds(dir)).toEqual(['native'])
  writeFileSync(filename, 'allowBuilds:\n  native: false\n')
  await expect(approveBuilds(dir, ['native'])).rejects.toThrow('stale-approval')
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({ allowBuilds: { native: false } })
})

it.each([
  'allowBuilds:\n  native: &pending set this to true or false\n  other: *pending\n',
  'allowBuilds: &builds\n  native: set this to true or false\nshared: *builds\n',
  'shared: &pending set this to true or false\nallowBuilds:\n  native: *pending\n',
])('rejects shared YAML approval nodes without changing permissions: %s', async (original) => {
  const { dir, filename } = fixture(original)
  await expect(approveBuilds(dir, ['native'])).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(original)
})
