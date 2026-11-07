/** Managed directory browsing preserves explicit grants independently of the model tool guard. */
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker from '../src/index.ts'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

let root: string, grants: string, context: Context
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-managed-directory-grants-'))
  grants = join(root, 'directory-grants.json')
  vi.stubEnv('DSH_DIRECTORY_GRANTS', grants)
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FILE', undefined)
  vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FD', undefined)
  context = new Context()
})
afterEach(async () => {
  try { await context.fiber.dispose() }
  finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})

async function load(): Promise<DirectoryPickerBrowseCapability> {
  const fiber = context.plugin(BrowseDirectoryPicker)
  await fiber.await()
  const capability = context.get('directoryPicker')!.capability()
  if (capability.kind !== 'browse') throw new Error('Expected the directory browser')
  return capability
}

it('lists a read-only grant but refuses directory creation inside it', async () => {
  const readonly = await mkdir(join(root, 'readonly')).then(() => join(root, 'readonly'))
  await writeFile(grants, JSON.stringify([{ path: readonly, mode: 'ro' }]))
  const capability = await load()
  expect((await capability.list(readonly)).path).toBe(readonly)
  await expect(capability.createDirectory(readonly, 'unauthorized')).rejects.toThrow('read-only')
  await expect(stat(join(readonly, 'unauthorized'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('creates one child inside an explicit writable grant', async () => {
  await writeFile(grants, JSON.stringify([{ path: root, mode: 'rw' }]))
  const capability = await load()
  expect(await capability.createDirectory(root, 'permitted')).toBe(join(root, 'permitted'))
  expect((await stat(join(root, 'permitted'))).isDirectory()).toBe(true)
})

it.each([
  ['outer-first', 'ro'], ['inner-first', 'ro'],
  ['outer-first', 'rw'], ['inner-first', 'rw'],
] as const)('uses the most specific %s grant for a nested %s directory', async (order, mode) => {
  const nested = join(root, 'nested')
  await mkdir(nested)
  const outer = { path: root, mode: mode === 'ro' ? 'rw' : 'ro' }, inner = { path: nested, mode }
  await writeFile(grants, JSON.stringify(order === 'outer-first' ? [outer, inner] : [inner, outer]))
  const capability = await load()
  if (mode === 'ro') {
    await expect(capability.createDirectory(nested, 'child')).rejects.toThrow('read-only')
    await expect(stat(join(nested, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })
  } else {
    expect(await capability.createDirectory(nested, 'child')).toBe(join(nested, 'child'))
  }
})

it('keeps an empty managed grant set denied instead of opening host directories', async () => {
  vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FILE', join(root, 'credential.json'))
  await writeFile(grants, '[]')
  const capability = await load()
  await expect(capability.list(root)).rejects.toThrow('authorized directories')
  await expect(capability.list()).rejects.toThrow('authorized directories')
  await expect(capability.createDirectory(root, 'unauthorized')).rejects.toThrow('authorized directories')
  expect(await readFile(grants, 'utf8')).toBe('[]')
  await expect(stat(join(root, 'unauthorized'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['missing', 'malformed', 'non-array', 'unresolvable', 'null-entry', 'invalid-mode', 'relative-path', 'file-root'] as const)('refuses a managed %s grants file at load', async (kind) => {
  vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FILE', join(root, 'credential.json'))
  if (kind === 'malformed') await writeFile(grants, '{')
  if (kind === 'non-array') await writeFile(grants, '{}')
  if (kind === 'unresolvable') await writeFile(grants, JSON.stringify([{ path: join(root, 'absent'), mode: 'rw' }]))
  if (kind === 'null-entry') await writeFile(grants, '[null]')
  if (kind === 'invalid-mode') await writeFile(grants, JSON.stringify([{ path: root, mode: 'invalid' }]))
  if (kind === 'relative-path') await writeFile(grants, JSON.stringify([{ path: '.', mode: 'rw' }]))
  if (kind === 'file-root') {
    const file = join(root, 'not-a-directory'); await writeFile(file, 'contents')
    await writeFile(grants, JSON.stringify([{ path: file, mode: 'rw' }]))
  }
  const fiber = context.plugin(BrowseDirectoryPicker)
  await expect(fiber.await().then(() => undefined)).rejects.toThrow('directory grants')
})

it('follows links only to granted directory objects and omits outside, broken and cyclic links', async () => {
  const owned = join(root, 'owned'), allowed = join(owned, 'allowed'), foreign = join(root, 'foreign')
  await mkdir(owned); await mkdir(allowed); await mkdir(foreign)
  await symlink(allowed, join(owned, 'permitted-link'), 'junction')
  await symlink(foreign, join(owned, 'outside-link'), 'junction')
  await symlink(join(root, 'missing'), join(owned, 'broken-link'), 'junction')
  await symlink(join(owned, 'cyclic-link'), join(owned, 'cyclic-link'), 'junction')
  await writeFile(grants, JSON.stringify([{ path: owned, mode: 'rw' }]))
  const capability = await load()
  expect((await capability.list(owned)).entries.map(row => row.name)).toEqual(['allowed', 'permitted-link'])
})

it('keeps managed grants on the inherited home when a project environment redirects the flattened path', async () => {
  const directory = join(root, 'readonly'), home = join(root, 'private-home')
  await mkdir(directory); await mkdir(home)
  await writeFile(join(home, 'directory-grants.json'), JSON.stringify([{ path: directory, mode: 'ro' }]))
  await writeFile(grants, JSON.stringify([{ path: root, mode: 'rw' }]))
  context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DSH_GATEWAY_CREDENTIAL_FD: '7', DSH_HOME: home } },
    { source: 'project-env', values: { DSH_DIRECTORY_GRANTS: grants } },
  ]))
  const capability = await load()
  await expect(capability.createDirectory(directory, 'unauthorized')).rejects.toThrow('read-only')
  await expect(capability.list(root)).rejects.toThrow('authorized directories')
})

it('refuses a managed launch without an inherited grants file or absolute private home', async () => {
  context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DSH_GATEWAY_CREDENTIAL_FD: '7' } },
  ]))
  const fiber = context.plugin(BrowseDirectoryPicker)
  await expect(fiber.await().then(() => undefined)).rejects.toThrow('directory grants')
})
