/** POSIX directory ownership and cancellation use real descriptors under controlled replacement. */
import { chmod, mkdir, mkdtemp, realpath, rename, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DirectoryHandle } from '@deepseek-ai/node-addon-system/directory'
import { openPinnedDirectory } from '../src/pinned-directory.ts'
import type { DirectoryRoot, PinnedDirectory } from '../src/pinned-directory.ts'

let root: string, owned: string, foreign: string, grant: DirectoryRoot
const levels: PinnedDirectory[] = []
const posixIt = it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pinned-browser-')))
  owned = join(root, 'owned'); foreign = join(root, 'foreign')
  await mkdir(owned); await mkdir(foreign)
  await mkdir(join(owned, 'permitted')); await mkdir(join(foreign, 'private'))
  const identity = await stat(owned, { bigint: true })
  grant = { path: owned, identity: { device: String(identity.dev), inode: String(identity.ino) } }
})
afterEach(async () => {
  const closed = await Promise.allSettled(levels.splice(0).map(level => level.close()))
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
  const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (failures.length > 0) throw new AggregateError(failures, 'Pinned directory fixture cleanup failed')
})

async function open(target = owned): Promise<PinnedDirectory> {
  const level = await openPinnedDirectory(grant, target, 1)
  levels.push(level)
  return level
}

posixIt('reads and creates through the original object while refusing its replaced logical path', async () => {
  const level = await open(), retained = join(root, 'retained')
  await level.verify()
  await rename(owned, retained); await symlink(foreign, owned, 'junction')
  expect(await level.read()).toMatchObject({ name: 'permitted', isDirectory: true })
  expect(await level.read()).toBeNull()
  await level.createDirectory('original-only')
  expect((await stat(join(retained, 'original-only'))).isDirectory()).toBe(true)
  await expect(stat(join(foreign, 'original-only'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(level.verify()).rejects.toThrow('replaced')
})

posixIt('refuses a new regular directory at the same grant path until grants are reloaded', async () => {
  await rename(owned, join(root, 'retained')); await mkdir(owned)
  await expect(open()).rejects.toThrow('root was replaced')
})

posixIt('does not traverse a replaced descendant into a foreign directory', async () => {
  const nested = join(owned, 'nested')
  await mkdir(nested); await rename(nested, join(owned, 'retained'))
  await symlink(foreign, nested, 'junction')
  await expect(open(nested)).rejects.toThrow()
  await expect(stat(join(foreign, 'created'))).rejects.toMatchObject({ code: 'ENOENT' })
})

posixIt('retains every parent until an abandoned consumer actually settles', async () => {
  // oxlint-disable-next-line typescript/unbound-method -- the captured method is invoked with the active handle as this.
  const original = DirectoryHandle.prototype.read
  const began = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  vi.spyOn(DirectoryHandle.prototype, 'read').mockImplementationOnce(async function (this: DirectoryHandle, count) {
    began.resolve(undefined)
    const entries = await original.call(this, count)
    await release.promise
    return entries
  })
  const close = vi.spyOn(DirectoryHandle.prototype, 'close'), level = await open()
  const reading = level.read()
  await began.promise
  try {
    const closing = level.close()
    expect(level.close()).toBe(closing)
    expect(close).not.toHaveBeenCalled()
    await expect(level.read()).rejects.toThrow('closed')
    await expect(level.createDirectory('late')).rejects.toThrow('closed')
    release.resolve(undefined)
    expect(await reading).toMatchObject({ name: 'permitted' })
    await closing
    expect(close.mock.calls.length).toBeGreaterThan(1)
    await expect(stat(join(owned, 'late'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([reading, level.close()])
  }
})

posixIt('releases parents after a consumer failure and keeps native setup errors visible', async () => {
  const level = await open()
  vi.spyOn(DirectoryHandle.prototype, 'read').mockRejectedValueOnce(new Error('read unavailable'))
  await expect(level.read()).rejects.toThrow('read unavailable')
  await level.close()
  await expect(openPinnedDirectory(grant, join(owned, 'absent'), 1)).rejects.toThrow()
})

posixIt('aggregates a failed grant check with cleanup failure after releasing all parent descriptors', async () => {
  // oxlint-disable-next-line typescript/unbound-method -- the captured method is invoked with the active handle as this.
  const original = DirectoryHandle.prototype.close
  vi.spyOn(DirectoryHandle.prototype, 'close').mockImplementationOnce(async function (this: DirectoryHandle) {
    await original.call(this)
    throw new Error('close acknowledgement unavailable')
  })
  await expect(openPinnedDirectory({ ...grant, identity: { device: '0', inode: '0' } }, owned, 1)).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'Authorized directory root was replaced' }), expect.any(AggregateError)],
  })
})

posixIt('stops opening the parent chain after an observed caller abort and closes the completed open', async () => {
  const controller = new AbortController()
  // oxlint-disable-next-line typescript/unbound-method -- the captured method is invoked with the active handle as this.
  const original = DirectoryHandle.prototype.openChild
  const opening = vi.spyOn(DirectoryHandle.prototype, 'openChild').mockImplementationOnce(async function (this: DirectoryHandle, name) {
    const child = await original.call(this, name)
    controller.abort(new Error('caller left during open'))
    return child
  })
  const closing = vi.spyOn(DirectoryHandle.prototype, 'close')
  await expect(openPinnedDirectory(grant, owned, 1, controller.signal)).rejects.toThrow('caller left during open')
  expect(opening).toHaveBeenCalledOnce()
  expect(closing).toHaveBeenCalledTimes(2)
})

it.skipIf((process.platform !== 'darwin' && process.platform !== 'linux') || process.getuid?.() === 0)('traverses an execute-only ancestor without requiring permission to list it', async () => {
  await chmod(root, 0o111)
  try {
    const level = await open()
    expect(await level.read()).toMatchObject({ name: 'permitted' })
    await level.createDirectory('created')
    expect((await stat(join(owned, 'created'))).isDirectory()).toBe(true)
  } finally { await chmod(root, 0o700) }
})
