/** Bounded Windows ACL-verdict replay inside the owner store; every read still opens and validates the record. */
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalRuntimeOwnerStore, type LocalRuntimeOwnerNonce, type LocalRuntimeOwnerRecord } from '../src/local-runtime-owner.ts'

const command = vi.hoisted(() => vi.fn())
vi.mock('../src/child-command.ts', () => ({ runGatewayChildCommand: command }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
const identity = { node: 'cached-node', kind: 'project' as const, ownerId: 7, runtimeKey: 'project-7',
  generation: 2, credentialHash: 'a'.repeat(64) }
const acl = (sids: string[]) => ({ stdout: JSON.stringify({ owner: 'S-1-5-18', deny: 0, sids }), stderr: '' })
const PRIVATE = acl(['S-1-5-18', 'S-1-5-32-544'])
const FOREIGN = acl(['S-1-5-18', 'S-1-5-32-545'])

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  command.mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Persist a valid reservation without lease work so both ACL probes start cold. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-owner-acl-cache-')); roots.push(root)
  const store = new LocalRuntimeOwnerStore(join(root, 'owners'), identity)
  await mkdir(store.directory, { recursive: true, mode: 0o700 })
  await writeFile(store.lockPath, '', { mode: 0o600 })
  const lock = await lstat(store.lockPath, { bigint: true })
  const record: LocalRuntimeOwnerRecord = {
    version: 1, identity, lock: { device: String(lock.dev), inode: String(lock.ino) },
    nonce: '01234567-89ab-4def-8123-0123456789ab' as LocalRuntimeOwnerNonce, token: 'a'.repeat(43),
    bootId: 'b5fbc474-5e65-4c06-8c46-8683ac34fce0', phase: 'reserved',
  }
  await writeFile(store.recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  return { store, record }
}

const probes = (path: string) => command.mock.calls.filter(call => (call[1] as string[]).at(-1) === path)

it('replays each private verdict across repeated reads', async () => {
  const { store } = await fixture()
  command.mockResolvedValue(PRIVATE)
  for (let i = 0; i < 3; i++) expect((await store.read())?.phase).toBe('reserved')
  expect(command).toHaveBeenCalledTimes(2)
  expect(probes(store.directory)).toHaveLength(1)
  expect(probes(store.recordPath)).toHaveLength(1)
})

it('re-probes the record when its file identity changes, not the directory', async () => {
  const { store, record } = await fixture()
  command.mockResolvedValue(PRIVATE)
  expect((await store.read())?.phase).toBe('reserved')
  const republished = { ...record, phase: 'starting' as const, url: 'http://127.0.0.1:43210/', groupPid: 4321 }
  const staging = join(store.directory, '.rewrite.tmp')
  await writeFile(staging, `${JSON.stringify(republished)}\n`, { mode: 0o600 })
  await rename(staging, store.recordPath)
  expect((await store.read())?.phase).toBe('starting')
  expect(probes(store.recordPath)).toHaveLength(2)
  expect(probes(store.directory)).toHaveLength(1)
  expect((await store.read())?.phase).toBe('starting')
  expect(probes(store.recordPath)).toHaveLength(2)
})

it('re-probes every not-private verdict and recovers on the next read', async () => {
  const { store } = await fixture()
  command.mockImplementation(async (_command: string, args: string[]) => args.at(-1) === store.recordPath ? FOREIGN : PRIVATE)
  for (let i = 0; i < 3; i++) await expect(store.read()).rejects.toThrow('bounded private file')
  expect(probes(store.recordPath)).toHaveLength(3)
  expect(probes(store.directory)).toHaveLength(1)
  command.mockResolvedValue(PRIVATE)
  expect((await store.read())?.phase).toBe('reserved')
  expect(probes(store.recordPath)).toHaveLength(4)
})

it('expires a replayed verdict once the bound passes', async () => {
  const { store } = await fixture()
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  command.mockResolvedValue(PRIVATE)
  expect((await store.read())?.phase).toBe('reserved')
  expect(command).toHaveBeenCalledTimes(2)
  now.mockReturnValue(1_009_999)
  expect((await store.read())?.phase).toBe('reserved')
  expect(command).toHaveBeenCalledTimes(2)
  now.mockReturnValue(1_010_000)
  expect((await store.read())?.phase).toBe('reserved')
  expect(command).toHaveBeenCalledTimes(4)
})
