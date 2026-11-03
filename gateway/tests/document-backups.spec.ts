/** Real private document roots and byte-verified deployment snapshots. */
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Pool } from 'pg'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'
import { UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { documentIdentityLocations } from '../src/document-storage.ts'
import { restoreGatewayDocumentBackup, verifyGatewayDocumentBackup } from '../src/document-backups.ts'
import { collectDeploymentData } from '../src/postgres/deployment-data.ts'
import { compareManagedFiles, restoreManagedSnapshot, snapshotManagedFiles } from '../src/managed-files.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { testConfig } from './test-config.ts'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { parseDocumentScopeBinding } from '../src/document-scope-storage.ts'

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hgw-document-backup-')))
  const engines: LocalUserDocFs[] = []
  const pool = new Pool({ host: '127.0.0.1', port: 1, database: 'fixture_test', user: 'fixture', password: 'fixture' })
  onTestFinished(async () => {
    const results = await Promise.allSettled(engines.map(engine => engine.dispose()))
    try { await pool.end() } finally { await rm(directory, { recursive: true, force: true }) }
    for (const result of results) if (result.status === 'rejected') throw result.reason
  })
  const cfg = testConfig(directory), home = join(cfg.usersRoot, 'reader', 'home'), root = join(home, 'documents')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
  const locations = await documentIdentityLocations(cfg, home, root, {
    organizationId: 'org', target: { kind: 'user', id: 7 }, projectionOwner: async () => null,
  })
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
  const context: PostgresRuntimeContext = { pool, organizationId: 'org', organizationSlug: 'default', nodeId: 'node', nodeName: 'node' }
  vi.spyOn(pool, 'query').mockImplementation(async sql => {
    const text = String(sql)
    const rows = text.includes('count(*)::text FROM harness.organizations') ? [{ organizations: '1', nodes: '1' }]
      : text.includes('SELECT u.public_id::text') ? [{ public_id: '7', username: 'reader', home_path: home, generation: 0 }] : []
    return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] }
  })
  const engine = createEngine()
  const capture = async () => {
    const paths = await collectDeploymentData(context, cfg), files = join(directory, 'snapshot')
    await mkdir(files, { mode: 0o700 })
    const snapshot = await snapshotManagedFiles(paths, files)
    await writeFile(join(files, 'manifest.json'), JSON.stringify(snapshot), { mode: 0o600 })
    return { paths, files, snapshot }
  }
  return { directory, root, cfg, locations, engine, createEngine, capture, context }
}

function body(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
}

it.each(['scope', 'retirement'] as const)('refuses document %s controls outside the protected state directory', async (kind) => {
  const f = await fixture()
  registerManagedDataPath({ owner: `gateway-document-${kind}/${'a'.repeat(64)}`, kind: 'file', path: join(f.directory, 'foreign-control.json') },
    join(f.cfg.stateRoot, 'document-identity-roots.jsonl'))
  await expect(collectDeploymentData(f.context, f.cfg)).rejects.toThrow('document-identity-control-location-changed')
})

it('requires the document inventory when a backup contains scope ownership controls', async () => {
  const f = await fixture(), { files, snapshot } = await f.capture()
  await expect(verifyGatewayDocumentBackup({ ...snapshot,
    roots: snapshot.roots.filter(row => row.owner !== 'gateway-document-inventory') }, files)).rejects.toThrow('Document backup inventory is missing')
})

it('refuses an unsupported scope ownership record in the copied backup', async () => {
  const f = await fixture(), { files, snapshot } = await f.capture()
  const owner = snapshot.roots.find(row => row.owner.startsWith('gateway-document-scope/'))
  const member = snapshot.files.find(row => row.sourcePath === owner?.path)
  if (member === undefined) throw new Error('Scope ownership is missing from the snapshot')
  const path = join(files, member.member), bytes = await readFile(path, 'utf8')
  const binding = parseDocumentScopeBinding(JSON.parse(bytes))
  try {
    await writeFile(path, JSON.stringify({ ...binding, version: 2 }))
    await expect(verifyGatewayDocumentBackup(snapshot, files)).rejects.toThrow()
  } finally { await writeFile(path, bytes) }
})

it('refuses two active identity domains for the same public directory', async () => {
  const f = await fixture()
  await f.engine.save(await f.engine.resolveTarget({ name: 'shared.txt' }), body('shared public bytes'))
  await f.engine.dispose()
  const key = 'f'.repeat(64), second = { root: f.root,
    stateRoot: join(f.cfg.stateRoot, 'document-identities', key), filesRoot: join(dirname(f.locations.filesRoot), key) }
  await mkdir(second.filesRoot, { recursive: true, mode: 0o700 })
  const other = f.createEngine(second)
  await other.list()
  await other.dispose()
  const inventory = join(f.cfg.stateRoot, 'document-identity-roots.jsonl')
  for (const [kind, path] of [['public', second.root], ['metadata', second.stateRoot], ['files', second.filesRoot]] as const) {
    registerManagedDataPath({ owner: `gateway-documents/${key}/${kind}`, kind: 'directory', path }, inventory)
  }
  const { files, snapshot } = await f.capture()
  await expect(verifyGatewayDocumentBackup(snapshot, files)).rejects.toThrow('multiple active owners')
  await expect(restoreGatewayDocumentBackup(snapshot, files)).rejects.toThrow('multiple active owners')
})

it('backs up never-started scopes and restores exact identities, retained links and trash actions', async () => {
  const f = await fixture(), target = await f.engine.resolveTarget({ name: 'same.txt' })
  const first = await f.engine.save(target, body('first publication'))
  const trashed = await f.engine.trash(first.docId)
  const replacement = await f.engine.save(target, body('new publication'))
  const rootId = await f.engine.identities!.rootId()
  await f.engine.dispose()
  const { paths, files, snapshot } = await f.capture()
  for (const path of [f.locations.root, f.locations.stateRoot, f.locations.filesRoot]) expect(paths.some(row => row.path === path)).toBe(true)
  await verifyGatewayDocumentBackup(snapshot, files)
  await writeFile(replacement.path, 'later unregistered edit')
  await restoreManagedSnapshot(files, snapshot, paths)
  expect(await compareManagedFiles(snapshot)).toEqual([])
  await expect(f.createEngine().warm()).rejects.toThrow('metadata domain')
  expect(await restoreGatewayDocumentBackup(snapshot, files)).toBe(1)
  const restored = f.createEngine()
  await restored.warm()
  expect(await restored.identities!.rootId()).toBe(rootId)
  expect((await restored.stat(replacement.docId)).identity).toEqual(replacement.identity)
  expect((await restored.read(replacement.docId)).data).toEqual(new TextEncoder().encode('new publication'))
  expect((await restored.listTrash())[0]).toMatchObject({ trashId: trashed.trashId, identity: trashed.identity })
  const active = await lstat(replacement.path), retained = await lstat(join(f.locations.filesRoot, 'objects', `${String(replacement.identity!.incarnationId)}.object`))
  expect([active.dev, active.ino]).toEqual([retained.dev, retained.ino])
  const recovered = await restored.restore(first.docId, undefined, undefined, undefined, {
    docId: trashed.docId, ...trashed.identity!, trashId: trashed.trashId!,
  })
  expect(recovered.identity?.incarnationId).toBe(first.identity!.incarnationId)
  expect(recovered.identity?.createdBy).toBe('user:7')
  expect((await restored.read(recovered.docId)).data).toEqual(new TextEncoder().encode('first publication'))
})

it('rejects incomplete kernel evidence before changing restored metadata or retained objects', async () => {
  const f = await fixture(), saved = await f.engine.save(await f.engine.resolveTarget({ name: 'proof.txt' }), body('protected'))
  await f.engine.dispose()
  const { paths, files, snapshot } = await f.capture()
  await restoreManagedSnapshot(files, snapshot, paths)
  const database = join(f.locations.stateRoot, 'metadata.sqlite'), before = await readFile(database)
  const incomplete = structuredClone(snapshot)
  delete incomplete.files.find(file => file.sourcePath === saved.path)!.object
  await expect(restoreGatewayDocumentBackup(incomplete, files)).rejects.toThrow('lacks object evidence')
  expect(await readFile(database)).toEqual(before)
  expect(await readFile(saved.path, 'utf8')).toBe('protected')
  expect(await restoreGatewayDocumentBackup(snapshot, files)).toBe(1)
})

it('refuses to certify an external edit that has not reached the identity journal', async () => {
  const f = await fixture(), saved = await f.engine.save(await f.engine.resolveTarget({ name: 'edited.txt' }), body('original'))
  await f.engine.dispose()
  await writeFile(saved.path, 'external bytes need reconciliation')
  const { files, snapshot } = await f.capture()
  await expect(verifyGatewayDocumentBackup(snapshot, files)).rejects.toThrow('committed file version')
  expect(await readFile(saved.path, 'utf8')).toBe('external bytes need reconciliation')
})

it('refuses a runtime-readable Gateway identity inventory and preserves existing document data', async () => {
  const f = await fixture()
  await f.engine.warm()
  await chmod(join(f.cfg.stateRoot, 'document-identity-roots.jsonl'), 0o644)
  await expect(collectDeploymentData(f.context, f.cfg)).rejects.toThrow('document-identity-inventory-must-be-gateway-owned')
})
