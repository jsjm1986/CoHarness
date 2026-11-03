/** Native volume reads keep their selected descriptors and cannot merge unrelated volumes sharing device numbers. */
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { DirectoryHandle } from '@deepseek-ai/node-addon-system/directory'
import { UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import { randomUUID } from 'node:crypto'
import { DocumentIdentityStorage } from '../src/identity-storage.ts'

afterEach(() => { vi.restoreAllMocks() })

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-storage-volume-'))
  onTestFinished(() => rm(base, { recursive: true, force: true }))
  const locations = { root: join(base, 'documents'), stateRoot: join(base, 'state'), filesRoot: join(base, 'files') }
  await mkdir(locations.root)
  return locations
}

it.skipIf(process.platform === 'win32')('rejects unrelated UUIDs even when directory device numbers agree', async () => {
  const locations = await fixture()
  vi.spyOn(DirectoryHandle.prototype, 'volumeIdentity').mockResolvedValueOnce('11111111-2222-3333-4444-555555555555')
    .mockResolvedValue('99999999-2222-3333-4444-555555555555')
  await expect(DocumentIdentityStorage.open(locations)).rejects.toThrow('same persistent filesystem')
})

it.skipIf(process.platform === 'win32')('refuses a directory replaced before its native volume descriptor is returned', async () => {
  const locations = await fixture(), original = DirectoryHandle.open.bind(DirectoryHandle)
  let changed = false
  vi.spyOn(DirectoryHandle, 'open').mockImplementation(async (path) => {
    if (path === locations.root && !changed) {
      changed = true; await rename(path, `${path}.original`); await mkdir(path)
    }
    return original(path)
  })
  // The selected replacement has a real descriptor, but cannot inherit the original directory's persistent binding.
  await expect(DocumentIdentityStorage.open(locations)).rejects.toThrow('changed while its volume identity was opened')
})

it.skipIf(process.platform === 'win32')('retains the opened object through volume completion and refuses a replaced logical path', async () => {
  const locations = await fixture()
  vi.spyOn(DirectoryHandle.prototype, 'volumeIdentity').mockImplementationOnce(async () => {
    await rename(locations.root, `${locations.root}.original`); await mkdir(locations.root)
    return '11111111-2222-3333-4444-555555555555'
  })
  await expect(DocumentIdentityStorage.open(locations)).rejects.toThrow('changed while its volume identity was read')
})

it.skipIf(process.platform === 'win32')('preserves a native volume syscall error and closes the borrowed descriptor', async () => {
  const locations = await fixture(), error = Object.assign(new Error('owned volume query failure'), { code: 'EIO' })
  vi.spyOn(DirectoryHandle.prototype, 'volumeIdentity').mockRejectedValueOnce(error)
  const close = vi.spyOn(DirectoryHandle.prototype, 'close')
  await expect(DocumentIdentityStorage.open(locations)).rejects.toBe(error)
  expect(close).toHaveBeenCalledTimes(1)
})

it('keeps Windows storage independent of a POSIX directory binding', async () => {
  const locations = await fixture(), descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const native = vi.spyOn(DirectoryHandle, 'open')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    const storage = await DocumentIdentityStorage.open(locations)
    expect(storage.binding.documents.volume).toBeUndefined()
    expect(native).not.toHaveBeenCalled()
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

it('refuses to bootstrap a missing marker when the caller requires an already bound domain', async () => {
  const storage = await DocumentIdentityStorage.open(await fixture())
  await writeFile(storage.databasePath, 'owned metadata', { mode: 0o600 })
  await expect(storage.bindDomain(UserDocRootId(randomUUID()), false)).rejects.toThrow('domain marker is missing')
})
