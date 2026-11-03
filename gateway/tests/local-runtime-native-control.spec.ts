/** Complete native-range evidence remains required after the original lease becomes free. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalRuntimeControl } from '../src/local-runtime-control.ts'
import { LocalRuntimeOwnerStore } from '../src/local-runtime-owner.ts'
import { localKernelBootId } from '../src/local-runtime-protocol.ts'

const native = vi.hoisted(() => ({ localLinuxRuntimeEmpty: vi.fn(), stopLocalLinuxRuntime: vi.fn() }))
vi.mock('../src/local-runtime-linux.ts', () => native)
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  native.localLinuxRuntimeEmpty.mockReset(); native.stopLocalLinuxRuntime.mockReset()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-native-control-')); directories.push(root)
  const store = new LocalRuntimeOwnerStore(join(root, 'owners'), { node: 'fixture', kind: 'user', ownerId: 1,
    runtimeKey: 'user-1', generation: 2, credentialHash: 'a'.repeat(64) })
  const lease = await store.acquire()
  try { await lease.create(await localKernelBootId(), 'linux-slice') } finally { await lease.close() }
  return { store, control: new LocalRuntimeControl(store, 10_000) }
}

it.skipIf(process.platform === 'win32')('retains capacity while native descendants survive a free parent lease, then recovers the same generation', async () => {
  const { store, control } = await fixture()
  const cleanupFailure = new Error('native descendant cleanup unconfirmed')
  native.localLinuxRuntimeEmpty.mockResolvedValue(false); native.stopLocalLinuxRuntime.mockRejectedValue(cleanupFailure)
  await expect(control.isAlive()).rejects.toThrow('has not published')
  expect(control.hasExited()).toBe(false)
  await expect(control.terminate(0)).rejects.toBe(cleanupFailure)
  expect((await store.read())?.phase).toBe('reserved')
  expect(control.hasExited()).toBe(false)
  expect(native.stopLocalLinuxRuntime).toHaveBeenCalledWith(expect.objectContaining({ nativeRange: 'linux-slice' }), expect.any(Number))
  for (const [, timeout] of native.stopLocalLinuxRuntime.mock.calls) expect(Number.isInteger(timeout)).toBe(true)
  native.localLinuxRuntimeEmpty.mockResolvedValue(true)
  native.stopLocalLinuxRuntime.mockResolvedValue(undefined)
  await control.terminate(0)
  expect(control.hasExited()).toBe(true)
  expect((await store.read())?.phase).toBe('stopped')
})

it.skipIf(process.platform === 'win32')('refuses to publish stop after a native observation failure', async () => {
  const { store, control } = await fixture(), failure = new Error('user manager observation unavailable')
  native.localLinuxRuntimeEmpty.mockRejectedValue(failure)
  await expect(control.terminate(0)).rejects.toBe(failure)
  expect(control.hasExited()).toBe(false)
  expect((await store.read())?.phase).toBe('reserved')
})
