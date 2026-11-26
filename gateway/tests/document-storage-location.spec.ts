/** Reopening document scopes preserves their registered physical object store. */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished } from 'vitest'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'
import { UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { readManagedDataPaths, registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { documentIdentityLocations } from '../src/document-storage.ts'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hgw-document-location-')))
  const engines: LocalUserDocFs[] = []
  onTestFinished(async () => {
    try { await Promise.all(engines.map(engine => engine.dispose())) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const stateRoot = join(root, 'state'), anchor = join(root, 'anchor'), nearer = join(anchor, 'shared')
  const home = join(nearer, 'account', 'home'), documentRoot = join(home, 'documents')
  await mkdir(stateRoot, { mode: 0o700 })
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(nearer, 0o777); await chmod(dirname(home), 0o777)
  const scope = { organizationId: 'org', target: { kind: 'user' as const, id: 7 }, projectionOwner: async () => null }
  const open = () => documentIdentityLocations({ stateRoot }, home, documentRoot, scope)
  const locations = await open()
  const createEngine = (selected = locations) => {
    const engine = new LocalUserDocFs({ root: selected.root, controlRoot: selected.filesRoot, identityLocations: selected,
      identityActor: () => UserDocUploadOwnerId('user:7'), limits: {
        maxFileBytes: 65536, maxFilesPerMessage: 5, maxMessageBytes: 131072, maxInlineTextBytes: 8192,
        upload: { protocol: 'resumable-v1', chunkBytes: 1024, sessionTtlMs: 60000, resumable: true },
      }, upload: { chunkBytes: 1024, sessionTtlMs: 60000, minFreeBytes: 0, maxConcurrent: 3,
        cleanupIntervalMs: 60000, manifestMaxBytes: 65536 }, sweepIntervalMs: 60000, trashRetentionMs: 60000,
    })
    engines.push(engine); return engine
  }
  const engine = createEngine()
  await engine.warm(); await engine.dispose()
  const inventory = join(stateRoot, 'document-identity-roots.jsonl')
  return { root, stateRoot, anchor, nearer, home, documentRoot, scope, open, locations, inventory, createEngine }
}

function storage(path: string) {
  const db = new DatabaseSync(join(path, 'metadata.sqlite'), { readOnly: true })
  try { return db.prepare('SELECT * FROM document_identity_storage').get() }
  finally { db.close() }
}

// Permission transitions use POSIX chmod; native Windows ACL reopening is verified in the deployment lane.
const posix = it.skipIf(process.platform === 'win32')

posix('keeps documents and retained bytes in the registered store when a nearer ancestor becomes protected', async () => {
  const f = await fixture(), before = storage(f.locations.stateRoot)
  const retained = join(f.locations.filesRoot, 'proof-bytes')
  await writeFile(retained, 'retained private bytes', { mode: 0o600 })
  const inode = (await lstat(f.locations.filesRoot, { bigint: true })).ino
  await chmod(f.nearer, 0o700)
  const reopened = await f.open()
  expect(reopened).toEqual(f.locations)
  await f.createEngine(reopened).warm()
  expect(storage(reopened.stateRoot)).toEqual(before)
  expect((await lstat(reopened.filesRoot, { bigint: true })).ino).toBe(inode)
  expect(await readFile(retained, 'utf8')).toBe('retained private bytes')
  await expect(lstat(join(f.nearer, '.hgw-document-files'))).rejects.toMatchObject({ code: 'ENOENT' })
})

posix.each(['private', 'parent', 'missing', 'link', 'ancestor-link', 'conflict', 'inventory-missing'] as const)
('refuses a registered store with %s evidence without choosing a fresh location', async invalid => {
  const f = await fixture(), bytes = await readFile(f.inventory), metadata = storage(f.locations.stateRoot)
  await chmod(f.nearer, 0o700)
  if (invalid === 'private') await chmod(f.locations.filesRoot, 0o755)
  else if (invalid === 'parent') await chmod(f.anchor, 0o777)
  else if (invalid === 'missing') await rename(f.locations.filesRoot, `${f.locations.filesRoot}-retained`)
  else if (invalid === 'link') {
    await rename(f.locations.filesRoot, `${f.locations.filesRoot}-retained`)
    await symlink(`${f.locations.filesRoot}-retained`, f.locations.filesRoot, 'dir')
  } else if (invalid === 'ancestor-link') {
    const base = dirname(f.locations.filesRoot)
    await rename(base, `${base}-retained`); await symlink(`${base}-retained`, base, 'dir')
  } else if (invalid === 'conflict') {
    registerManagedDataPath({ owner: `gateway-documents/${basename(f.locations.filesRoot)}/files`, kind: 'directory',
      path: join(f.nearer, '.hgw-document-files', basename(f.locations.filesRoot)) }, f.inventory)
  } else {
    const rows = bytes.toString().trim().split('\n').map(line => JSON.parse(line) as { owner: string })
    await writeFile(f.inventory, rows.filter(row => !row.owner.startsWith('gateway-documents/')).map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  await expect(f.open()).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  expect(storage(f.locations.stateRoot)).toEqual(metadata)
  await expect(lstat(join(f.nearer, '.hgw-document-files'))).rejects.toMatchObject({ code: 'ENOENT' })
})

posix('serializes concurrent first initialization and preserves one registered location', async () => {
  const f = await fixture(), second = join(f.nearer, 'other', 'home')
  await mkdir(second, { recursive: true, mode: 0o700 })
  const open = () => documentIdentityLocations({ stateRoot: f.stateRoot }, second, join(second, 'documents'), {
    ...f.scope, target: { kind: 'user', id: 8 },
  })
  const pair = await Promise.all([open(), open()])
  expect(pair[0]).toEqual(pair[1])
  const key = createHash('sha256').update(JSON.stringify([second, 'org', 'user', 8])).digest('hex')
  expect(readManagedDataPaths(f.inventory).filter(row => row.owner.startsWith(`gateway-documents/${key}/`))).toHaveLength(3)
})
