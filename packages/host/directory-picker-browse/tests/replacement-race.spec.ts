/** Real directory replacement between grant classification and filesystem dispatch. */
import { renameSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DirectoryHandle } from '@deepseek-ai/node-addon-system/directory'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker from '../src/index.ts'

const fault = vi.hoisted(() => ({
  path: '', swap: undefined as (() => void) | undefined, attempted: false, swapped: false,
}))

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const resolvePath = (...args: Parameters<typeof actual.realpathSync>) => {
    const path = actual.realpathSync(...args)
    if (args[0] === fault.path && fault.swap !== undefined) {
      const swap = fault.swap
      fault.swap = undefined
      fault.attempted = true
      swap()
      fault.swapped = true
    }
    return path
  }
  return { ...actual, realpathSync: Object.assign(resolvePath, { native: actual.realpathSync.native }) }
})

let root: string, owned: string, foreign: string, context: Context
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-browse-replacement-')))
  owned = join(root, 'owned'); foreign = join(root, 'foreign')
  await mkdir(owned); await mkdir(foreign)
  await mkdir(join(owned, 'permitted'))
  await mkdir(join(foreign, 'private-foreign-directory'))
  const grants = join(root, 'directory-grants.json')
  await writeFile(grants, JSON.stringify([{ path: owned, mode: 'rw' }]))
  context = new Context()
  context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DSH_GATEWAY_CREDENTIAL_FD: '7', DSH_DIRECTORY_GRANTS: grants } },
  ]))
  fault.path = owned; fault.attempted = false; fault.swapped = false; fault.swap = undefined
})
afterEach(async () => {
  fault.swap = undefined
  vi.restoreAllMocks()
  try { await context.fiber.dispose() }
  finally { await rm(root, { recursive: true, force: true }) }
})

async function load(): Promise<DirectoryPickerBrowseCapability> {
  const fiber = context.plugin(BrowseDirectoryPicker)
  await fiber.await()
  const capability = context.get('directoryPicker')?.capability()
  if (capability?.kind !== 'browse') throw new Error('Expected the directory browser')
  return capability
}

function replaceAfterClassification(): void {
  fault.swap = () => {
    renameSync(owned, join(root, 'retained-original'))
    symlinkSync(foreign, owned, 'junction')
  }
}

it('does not publish a foreign directory opened after its authorized path was replaced', async () => {
  const capability = await load()
  replaceAfterClassification()
  const result = await capability.list(owned).then(
    value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }),
  )
  expect(fault.attempted).toBe(true)
  expect(fault.swapped).toBe(true)
  expect(result).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })
})

it('does not create in a foreign directory substituted after the grant check', async () => {
  const capability = await load()
  replaceAfterClassification()
  const result = await capability.createDirectory(owned, 'unauthorized').then(
    value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }),
  )
  expect(fault.attempted).toBe(true)
  expect(fault.swapped).toBe(true)
  const foreignChild = await stat(join(foreign, 'unauthorized')).then(() => true, (error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  })
  expect(foreignChild).toBe(false)
  expect(result).toMatchObject({ ok: false, error: { code: 'directory-create-failed' } })
})

it('keeps ordinary granted listing and creation available', async () => {
  const capability = await load()
  expect((await capability.list(owned)).entries.map(row => row.name)).toEqual(['permitted'])
  expect(await capability.createDirectory(owned, 'created')).toBe(join(owned, 'created'))
  expect((await stat(join(owned, 'created'))).isDirectory()).toBe(true)
  expect(fault.attempted).toBe(false)
})

it.skipIf(process.platform === 'win32')('refuses to publish a listing after its opened parent was replaced', async () => {
  const capability = await load()
  // oxlint-disable-next-line typescript/unbound-method -- the captured method is invoked with the active handle as this.
  const original = DirectoryHandle.prototype.read
  const reading = vi.spyOn(DirectoryHandle.prototype, 'read').mockImplementationOnce(async function (this: DirectoryHandle, count) {
    renameSync(owned, join(root, 'retained-original'))
    symlinkSync(foreign, owned, 'junction')
    return original.call(this, count)
  })
  await expect(capability.list(owned)).rejects.toMatchObject({ code: 'directory-unreadable' })
  expect(reading).toHaveBeenCalled()
  expect((await stat(join(foreign, 'private-foreign-directory'))).isDirectory()).toBe(true)
})

it.skipIf(process.platform === 'win32')('refuses a stale success path after a descriptor-relative creation', async () => {
  const capability = await load()
  // oxlint-disable-next-line typescript/unbound-method -- the captured method is invoked with the active handle as this.
  const original = DirectoryHandle.prototype.createDirectory
  const creating = vi.spyOn(DirectoryHandle.prototype, 'createDirectory').mockImplementationOnce(async function (this: DirectoryHandle, name) {
    renameSync(owned, join(root, 'retained-original'))
    symlinkSync(foreign, owned, 'junction')
    return original.call(this, name)
  })
  await expect(capability.createDirectory(owned, 'original-only')).rejects.toMatchObject({ code: 'directory-create-failed' })
  expect(creating).toHaveBeenCalledOnce()
  expect((await stat(join(root, 'retained-original/original-only'))).isDirectory()).toBe(true)
  await expect(stat(join(foreign, 'original-only'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')('returns on abort while retaining the directory chain until its reader settles', async () => {
  const capability = await load(), controller = new AbortController(), release = Promise.withResolvers<undefined>()
  const drained = Promise.withResolvers<undefined>(), filesystemRoot = await stat('/', { bigint: true })
  // oxlint-disable-next-line typescript/unbound-method -- the captured method is invoked with the active handle as this.
  const originalRead = DirectoryHandle.prototype.read
  // oxlint-disable-next-line typescript/unbound-method -- the captured method is invoked with the active handle as this.
  const originalClose = DirectoryHandle.prototype.close
  const closing = vi.spyOn(DirectoryHandle.prototype, 'close').mockImplementation(async function (this: DirectoryHandle) {
    await originalClose.call(this)
    if (this.identity.device === filesystemRoot.dev && this.identity.inode === filesystemRoot.ino) drained.resolve(undefined)
  })
  vi.spyOn(DirectoryHandle.prototype, 'read').mockImplementationOnce(async function (this: DirectoryHandle, count) {
    controller.abort(new Error('caller departed during read'))
    const entries = await originalRead.call(this, count)
    await release.promise
    return entries
  })
  try {
    await expect(capability.list(owned, controller.signal)).rejects.toThrow('caller departed during read')
    expect(closing).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await drained.promise }
})

it.skipIf(process.platform === 'win32')('surfaces an authorized-link cleanup failure instead of silently omitting its row', async () => {
  symlinkSync(join(owned, 'permitted'), join(owned, 'a-permitted-link'), 'junction')
  const capability = await load()
  // oxlint-disable-next-line typescript/unbound-method -- the captured method is invoked with the active handle as this.
  const original = DirectoryHandle.prototype.close
  vi.spyOn(DirectoryHandle.prototype, 'close').mockImplementationOnce(async function (this: DirectoryHandle) {
    await original.call(this)
    throw new Error('link close acknowledgement unavailable')
  })
  await expect(capability.list(owned)).rejects.toMatchObject({ code: 'directory-unreadable' })
})
