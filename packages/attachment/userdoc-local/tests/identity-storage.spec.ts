/** Separate real directories, kernel bindings and bounded private markers prevent accidental domain adoption. */

import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import { DocumentIdentityStorage } from '../src/identity-storage.ts'

const faults = vi.hoisted(() => ({
  objects: new Map<string, { dev?: bigint; ino?: bigint; uid?: bigint }>(),
  readLimit: 0, shortSizePath: '', changedHandlePath: '',
  failedLookup: '', failedMkdir: '',
}))

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]) === faults.failedMkdir) throw Object.assign(new Error('owned private directory creation failure'), { code: 'EIO' })
      return actual.mkdir(...args)
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === faults.failedLookup) throw Object.assign(new Error('owned marker lookup failure'), { code: 'EIO' })
      const info = await actual.lstat(...args), patch = faults.objects.get(String(args[0]))
      return new Proxy(info, { get(target, key, receiver) {
        if (String(args[0]) === faults.shortSizePath && key === 'size') return 1
        if ((key === 'dev' || key === 'ino' || key === 'uid') && patch?.[key] !== undefined) {
          return typeof target[key] === 'bigint' ? patch[key] : Number(patch[key])
        }
        const value: unknown = Reflect.get(target, key, receiver)
        return value
      } })
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args), path = String(args[0])
      return new Proxy(handle, { get(target, key) {
        if (key === 'read' && faults.readLimit > 0) {
          return (buffer: Uint8Array, offset: number, length: number, position: number) =>
            target.read(buffer, offset, Math.min(length, faults.readLimit), position)
        }
        if (key === 'stat' && (path === faults.shortSizePath || path === faults.changedHandlePath)) {
          return async () => {
            const info = await target.stat()
            return new Proxy(info, { get(value, property, receiver) {
              if (property === 'size' && path === faults.shortSizePath) return 1
              if (property === 'ino' && path === faults.changedHandlePath) return value.ino + 1
              const selected: unknown = Reflect.get(value, property, receiver)
              return selected
            } })
          }
        }
        const value: unknown = Reflect.get(target, key)
        if (typeof value === 'function') { const bound: unknown = value.bind(target); return bound }
        return value
      } })
    },
  }
})

afterEach(() => {
  faults.objects.clear(); faults.readLimit = 0; faults.shortSizePath = ''; faults.changedHandlePath = ''
  faults.failedLookup = ''; faults.failedMkdir = ''
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-document-storage-'))
  onTestFinished(() => rm(base, { recursive: true, force: true }))
  const locations = { root: join(base, 'documents'), stateRoot: join(base, 'state'), filesRoot: join(base, 'files') }
  await mkdir(locations.root)
  const storage = await DocumentIdentityStorage.open(locations), rootId = UserDocRootId(randomUUID())
  await writeFile(storage.databasePath, 'metadata fixture', { mode: 0o600 })
  return { base, locations, storage, rootId, marker: join(locations.filesRoot, 'domain.json') }
}

it('keeps provider records outside ordinary files and preserves the private domain across reopen', async () => {
  const f = await fixture()
  await f.storage.bindDomain(f.rootId)
  const before = await readFile(f.marker, 'utf8')
  const reopened = await DocumentIdentityStorage.open(f.locations)
  await reopened.bindDomain(f.rootId)
  expect(await readFile(f.marker, 'utf8')).toBe(before)
  expect(await readdir(f.locations.root)).toEqual([])
  expect(f.storage.fileRoot(join(f.locations.root, 'report.txt'))).toBe(f.locations.root)
  expect(f.storage.fileRoot(join(f.locations.filesRoot, 'objects', 'record'))).toBe(f.locations.filesRoot)
  expect(() => f.storage.fileRoot(f.storage.databasePath)).toThrow('outside')
})

it.each(['root', 'stateRoot', 'filesRoot'] as const)('refuses a replaced directory: %s', async (key) => {
  const f = await fixture(), path = f.locations[key]
  await rename(path, `${path}.retained`)
  await mkdir(path, { mode: 0o700 })
  await expect(f.storage.verify()).rejects.toThrow('changed')
  await rm(path, { recursive: true })
  await rename(`${path}.retained`, path)
  await f.storage.verify()
})

it('rejects relative and overlapping configured locations before creating private data', async () => {
  const f = await fixture()
  await expect(DocumentIdentityStorage.open({ ...f.locations, root: 'documents' })).rejects.toThrow('absolute')
  await expect(DocumentIdentityStorage.open({ ...f.locations, stateRoot: join(f.locations.root, 'state') })).rejects.toThrow('overlap')
  await expect(DocumentIdentityStorage.open({ ...f.locations, filesRoot: f.locations.stateRoot })).rejects.toThrow('overlap')
})

it('rejects an existing file where a private directory belongs', async () => {
  const f = await fixture(), path = join(f.base, 'occupied')
  await writeFile(path, 'foreign')
  await expect(DocumentIdentityStorage.open({ ...f.locations, stateRoot: path })).rejects.toThrow('real directory')
  expect(await readFile(path, 'utf8')).toBe('foreign')
})

it('rejects a linked public root and retains its target', async () => {
  const f = await fixture(), alias = join(f.base, 'alias')
  await symlink(f.locations.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(DocumentIdentityStorage.open({ ...f.locations, root: alias })).rejects.toThrow('real directory')
  expect(await readdir(f.locations.root)).toEqual([])
})

it.skipIf(process.platform === 'win32')('rejects wider private access without changing existing permissions', async () => {
  const f = await fixture()
  await chmod(f.locations.stateRoot, 0o755)
  await expect(DocumentIdentityStorage.open(f.locations)).rejects.toThrow('owning process account')
  expect((await lstat(f.locations.stateRoot)).mode & 0o777).toBe(0o755)
})

it.skipIf(process.getuid === undefined)('rejects a private directory owned by another account', async () => {
  const f = await fixture(), info = await lstat(f.locations.stateRoot, { bigint: true })
  faults.objects.set(f.locations.stateRoot, { uid: info.uid + 1n })
  await expect(DocumentIdentityStorage.open(f.locations)).rejects.toThrow('owning process account')
})

it('rejects missing parents, unreliable kernel identities and another device', async () => {
  const f = await fixture()
  await expect(DocumentIdentityStorage.open({ ...f.locations, stateRoot: join(f.base, 'absent', 'state') }))
    .rejects.toMatchObject({ code: 'ENOENT' })
  faults.objects.set(f.locations.root, { ino: 0n })
  await expect(DocumentIdentityStorage.open(f.locations)).rejects.toThrow('real directory')
  faults.objects.clear()
  const info = await lstat(f.locations.filesRoot, { bigint: true })
  faults.objects.set(f.locations.filesRoot, { dev: info.dev + 1n })
  await expect(DocumentIdentityStorage.open(f.locations)).rejects.toThrow('document filesystem')
})

it('rejects different path spellings of the same physical directory object', async () => {
  const f = await fixture(), info = await lstat(f.locations.root, { bigint: true })
  faults.objects.set(f.locations.filesRoot, { dev: info.dev, ino: info.ino })
  await expect(DocumentIdentityStorage.open(f.locations)).rejects.toThrow('alias each other')
})

it('refuses adopting existing private files without a committed domain marker', async () => {
  const f = await fixture(), unknown = join(f.locations.filesRoot, 'existing.object')
  await writeFile(unknown, 'retained bytes')
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('contains existing files')
  expect(await readFile(unknown, 'utf8')).toBe('retained bytes')
})

it('retains interrupted marker staging while initializing a previously empty domain', async () => {
  const f = await fixture(), partial = join(f.locations.filesRoot, 'domain.json.0123456789ab.tmp')
  await writeFile(partial, 'incomplete bootstrap')
  await f.storage.bindDomain(f.rootId)
  expect(await readFile(partial, 'utf8')).toBe('incomplete bootstrap')
})

it('refuses another domain and a copied metadata file while preserving their bytes', async () => {
  const f = await fixture()
  await f.storage.bindDomain(f.rootId)
  await expect(f.storage.bindDomain(UserDocRootId(randomUUID()))).rejects.toThrow('another metadata domain')
  const retained = `${f.storage.databasePath}.retained`
  await rename(f.storage.databasePath, retained)
  await copyFile(retained, f.storage.databasePath)
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('metadata file changed after it was opened')
  expect(await readFile(f.storage.databasePath, 'utf8')).toBe('metadata fixture')
})

it('refuses another state directory even when its copied database has the same logical domain', async () => {
  const f = await fixture()
  await f.storage.bindDomain(f.rootId)
  const stateRoot = join(f.base, 'second-state'), second = await DocumentIdentityStorage.open({ ...f.locations, stateRoot })
  await copyFile(f.storage.databasePath, second.databasePath)
  await expect(second.bindDomain(f.rootId)).rejects.toThrow('another metadata domain or database file')
})

it.each(['null', '[]', '{}', '{"version":2}', '{"version":1,"rootId":"different"}'])
('refuses incomplete or unrelated durable marker data: %s', async (text) => {
  const f = await fixture()
  await writeFile(f.marker, text, { mode: 0o600 })
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('another metadata domain')
})

it('bounds the entire marker read and continues after short filesystem reads', async () => {
  const f = await fixture()
  await f.storage.bindDomain(f.rootId)
  faults.readLimit = 3
  await f.storage.bindDomain(f.rootId)
  await writeFile(f.marker, 'x'.repeat(1025))
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('Invalid private document domain marker')
  faults.shortSizePath = f.marker
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('too large')
})

it('refuses a marker changed between directory lookup and descriptor acquisition', async () => {
  const f = await fixture()
  await f.storage.bindDomain(f.rootId)
  faults.changedHandlePath = f.marker
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('changed while opening')
})


it('rejects a private location entering the public root through an ancestor link before creating its leaf', async () => {
  const f = await fixture(), parent = join(f.locations.root, 'private-parent'), alias = join(f.base, 'alias')
  await mkdir(parent, { mode: 0o700 })
  await symlink(f.locations.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(DocumentIdentityStorage.open({ ...f.locations, stateRoot: join(alias, 'private-parent', 'state') }))
    .rejects.toThrow('resolve to overlapping')
  expect(await readdir(parent)).toEqual([])
})

it('checks layout and domain binding when POSIX account APIs are unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid')
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined })
  try {
    const f = await fixture()
    await f.storage.bindDomain(f.rootId)
    await f.storage.verify()
  } finally {
    if (descriptor === undefined) delete process.getuid
    else Object.defineProperty(process, 'getuid', descriptor)
  }
})

it('refuses non-file private markers and a non-file metadata path', async () => {
  const f = await fixture()
  await mkdir(f.marker)
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('Invalid private document domain marker')
  await rm(f.storage.databasePath)
  await mkdir(f.storage.databasePath)
  await expect(f.storage.metadataFile()).rejects.toThrow('not regular')
})

it.skipIf(process.platform === 'win32')('checks private access on database and marker inodes as well as their parents', async () => {
  const f = await fixture()
  await chmod(f.storage.databasePath, 0o644)
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('owning process account')
  await chmod(f.storage.databasePath, 0o600)
  await f.storage.bindDomain(f.rootId)
  await chmod(f.marker, 0o644)
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('owning process account')
})

it.each(['version', 'rootId', 'state', 'database'])('refuses a missing durable marker field: %s', async (key) => {
  const f = await fixture()
  await f.storage.bindDomain(f.rootId)
  const marker = JSON.parse(await readFile(f.marker, 'utf8')) as Record<string, unknown>
  await writeFile(f.marker, JSON.stringify(Object.fromEntries(Object.entries(marker).filter(([field]) => field !== key))))
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('another metadata domain')
})

it.each([null, [], {}, { device: 'wrong' }, { device: '0', inode: 'wrong' }])
('refuses inconsistent recorded directory/file evidence: %j', async (value) => {
  const f = await fixture()
  await f.storage.bindDomain(f.rootId)
  const marker = JSON.parse(await readFile(f.marker, 'utf8')) as Record<string, unknown>
  await writeFile(f.marker, JSON.stringify({ ...marker, state: value }))
  await expect(f.storage.bindDomain(f.rootId)).rejects.toThrow('another metadata domain')
})

it('accepts reordered evidence fields with the same directory and file identities', async () => {
  const f = await fixture()
  await f.storage.bindDomain(f.rootId)
  const marker = JSON.parse(await readFile(f.marker, 'utf8')) as {
    version: number
    rootId: string
    state: { device: string; inode: string }
    database: { device: string; inode: string }
  }
  await writeFile(f.marker, JSON.stringify({ ...marker, state: { inode: marker.state.inode, device: marker.state.device },
    database: { inode: marker.database.inode, device: marker.database.device } }))
  await f.storage.bindDomain(f.rootId)
})


it('preserves private-directory creation and marker lookup failures', async () => {
  const f = await fixture()
  faults.failedMkdir = join(f.base, 'denied-state')
  await expect(DocumentIdentityStorage.open({ ...f.locations, stateRoot: faults.failedMkdir }))
    .rejects.toMatchObject({ code: 'EIO' })
  faults.failedLookup = f.marker
  await expect(f.storage.bindDomain(f.rootId)).rejects.toMatchObject({ code: 'EIO' })
})
