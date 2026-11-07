/** Real Loader, signed Gateway transport, retained filesystem objects and offline mount recovery. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const mode = process.argv[2]
assert.ok(mode === 'src' || mode === 'lib')
const repo = new URL('../../../../../', import.meta.url), artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = name => new URL(`packages/${name}/${artifact}`, repo)
const { boot } = await import(entry('boot/app-boot'))
const { LocalUserDocFs } = await import(entry('attachment/userdoc-local'))
const { UserDocDirectoryId, UserDocUploadOwnerId, UserDocError } = await import(entry('attachment/userdoc'))
const { serveGatewayDocumentStore } = await import(new URL(`packages/attachment/userdoc-gateway/${mode === 'src' ? 'src/server.ts' : 'lib/server.js'}`, repo))
const { DirectoryHandle } = await import(new URL(`native/system/packages/entry/${mode === 'src' ? 'src/directory.ts' : 'lib/directory.js'}`, repo))
// The UUID is an external OS input; every descriptor, inode, body stream and SQLite operation remains real.
DirectoryHandle.prototype.volumeIdentity = async () => '11111111-2222-3333-4444-555555555555'
const root = process.cwd(), domain = join(root, 'domain')
const locations = { root: join(domain, 'documents'), stateRoot: join(domain, 'state'), filesRoot: join(domain, 'files') }
await mkdir(domain, { mode: 0o700 }); await mkdir(locations.root); await mkdir(locations.filesRoot, { mode: 0o700 })
const actor = new AsyncLocalStorage(), limits = { maxFileBytes: null, maxFilesPerMessage: 8, maxMessageBytes: 1024 * 1024,
  maxInlineTextBytes: 1024, upload: { protocol: 'resumable-v1', chunkBytes: 2, sessionTtlMs: 60000, resumable: true } }
const createEngine = (selected = locations) => new LocalUserDocFs({ root: selected.root, controlRoot: selected.filesRoot,
  identityLocations: selected, identityActor: () => actor.getStore(), limits,
  upload: { chunkBytes: 2, sessionTtlMs: 60000, minFreeBytes: 0, maxConcurrent: 8, cleanupIntervalMs: 60000, manifestMaxBytes: 65536 },
  sweepIntervalMs: 60000, trashRetentionMs: 60000,
})
let engine = createEngine(), ctx
const { publicKey } = generateKeyPairSync('ed25519'), token = 'owned-mount-runtime-token'
const lifetime = new AbortController(), work = new Set(), failures = []
const expectedWarmFailures = new Set()
const scopes = new Map([7, 9].map(id => [`mount-${id}:${randomUUID()}`, id]))
const metadata = createServer((request, response) => {
  const task = Promise.resolve().then(async () => {
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    assert.equal(request.url, '/internal/runtime/documents/store')
    await serveGatewayDocumentStore(request, response, { maxMetadataBytes: 4 * 1024 * 1024, signal: lifetime.signal,
      async withStore(envelope, signal, operation) {
        const owner = envelope.authority.kind === 'execution' ? scopes.get(`${envelope.authority.sessionId}:${envelope.authority.scopeId}`) : undefined
        if (envelope.operation.kind !== 'describe' && owner === undefined) throw new UserDocError('Missing fixture actor.', 'DOCUMENT_PERMISSION_DENIED')
        return actor.run(owner === undefined ? undefined : UserDocUploadOwnerId(`user:${owner}`), async () => {
          await engine.warm()
          return operation({ store: engine, signal, ...(owner === undefined ? {} : { ownerId: UserDocUploadOwnerId(`user:${owner}`) }), async finish() {} })
        })
      },
    })
  })
  work.add(task)
  void task.then(() => work.delete(task), error => {
    work.delete(task)
    if (!expectedWarmFailures.delete(error)) failures.push(error)
    response.destroy(error)
  })
})
const config = new URL('../../../../../examples/headless-agent/tests/fixtures/attachment/userdoc-mount/cordis.yml', import.meta.url)
const credentialFile = join(root, 'credential.json'), databasePath = join(locations.stateRoot, 'metadata.sqlite')
const markerPath = join(locations.filesRoot, 'domain.json')
const body = text => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const select = id => {
  const key = [...scopes].find(([, owner]) => owner === id)[0], split = key.indexOf(':')
  ctx.get('fixtureDocumentMountActor').scope = { parentSessionId: key.slice(0, split), scopeId: key.slice(split + 1),
    primaryActorUserId: id, inputs: [], unverifiedHistory: false }
}
const start = async () => { process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialFile; ctx = await boot('document-mount-fixture', fileURLToPath(config)); delete process.env.DSH_GATEWAY_CREDENTIAL_FILE }
const stop = async () => { await ctx?.fiber.dispose(); ctx = undefined; await engine.dispose() }
const remount = async legacy => {
  const info = await lstat(databasePath, { bigint: true }), device = String(info.dev + 1n), database = new DatabaseSync(databasePath)
  try {
    database.prepare('UPDATE document_identity_storage SET documents_device=?,files_device=?').run(device, device)
    database.prepare("UPDATE document_identities SET record=json_set(record,'$.file.device',?)").run(device)
    database.prepare("UPDATE document_projection_changes SET document=json_set(document,'$.file.device',?)").run(device)
    if (legacy) database.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
      ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=3`)
  } finally { database.close() }
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  marker.state.device = device; marker.database.device = device
  if (legacy) { marker.version = 1; delete marker.state.volume; delete marker.database.volume }
  await writeFile(markerPath, JSON.stringify(marker))
  return device
}
try {
  await new Promise((resolve, reject) => { metadata.once('error', reject); metadata.listen(0, '127.0.0.1', resolve) })
  await writeFile(credentialFile, JSON.stringify({ version: 1, gatewayUrl: `http://127.0.0.1:${metadata.address().port}`,
    organization: 'mount-fixture', runtime: { kind: 'project', id: 41, generation: 1 }, token,
    principalPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), { mode: 0o600 })
  await start(); select(7)
  const saved = await ctx.userDocs.save(await ctx.userDocs.resolveTarget({ name: 'owned.txt' }), body('owner bytes'))
  assert.equal(saved.identity.createdBy, 'user:7')
  const upload = await ctx.userDocs.beginUpload({ name: 'pending.txt', directoryId: UserDocDirectoryId(''), bytes: 4, fingerprint: 'mount-upload' })
  await ctx.userDocs.writeUploadChunk(upload.uploadId, { index: 0, start: 0, end: 1, total: 4,
    sha256: createHash('sha256').update('ab').digest('hex'), body: body('ab') })
  output({ operation: 'managed-startup', providerReady: true, creator: saved.identity.createdBy, receivedBytes: 2 })
  await stop(); await remount(false); engine = createEngine(); await start(); select(7)
  assert.deepEqual((await ctx.userDocs.stat(saved.docId)).identity, saved.identity)
  assert.equal((await ctx.userDocs.inspectUpload(upload.uploadId)).receivedBytes, 2)
  select(9); await assert.rejects(ctx.userDocs.inspectUpload(upload.uploadId), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' }); select(7)
  output({ operation: 'persistent-remount', providerReady: true, identityPreserved: true, ownerPreserved: true, foreignResume: 'denied' })
  await stop(); await remount(true)
  engine = createEngine()
  await start(); select(7)
  assert.deepEqual((await ctx.userDocs.stat(saved.docId)).identity, saved.identity)
  assert.equal((await ctx.userDocs.inspectUpload(upload.uploadId)).receivedBytes, 2)
  select(9); await assert.rejects(ctx.userDocs.inspectUpload(upload.uploadId), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' }); select(7)
  output({ operation: 'remount-healed', selfHealedOnOpen: true, providerReady: true, identityPreserved: true, receivedBytes: 2, foreignResume: 'denied' })
  await stop(); const copied = join(root, 'copied'); await cp(domain, copied, { recursive: true })
  engine = createEngine({ root: join(copied, 'documents'), filesRoot: join(copied, 'files'), stateRoot: join(copied, 'state') })
  await assert.rejects(engine.warm())
  assert.equal(await readFile(saved.path, 'utf8'), 'owner bytes')
  output({ operation: 'copied-root', refused: true, originalBytesPreserved: true })
  assert.deepEqual(failures, [])
} finally {
  await stop(); lifetime.abort(new Error('Document mount replay finished'))
  await new Promise(resolve => metadata.close(resolve)); await Promise.all(work)
}
