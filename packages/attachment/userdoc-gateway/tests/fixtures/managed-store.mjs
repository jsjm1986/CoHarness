/** Real Loader, signed runtime HTTP, Gateway document transport and filesystem business acceptance. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

const mode = process.argv[2], wrongPriority = process.argv[3] === 'borrow-viewer'
assert.ok(mode === 'src' || mode === 'lib')
const repo = new URL('../../../../../', import.meta.url), artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const moduleUrl = name => new URL(`packages/${name}/${artifact}`, repo)
const { boot } = await import(moduleUrl('boot/app-boot'))
const { UserDocDirectoryId, UserDocId, UserDocUploadOwnerId, UserDocError, DOCUMENT_PERMISSION_DENIED_CODE } = await import(moduleUrl('attachment/userdoc'))
const { LocalUserDocFs } = await import(moduleUrl('attachment/userdoc-local'))
const { GATEWAY_PRINCIPAL_HEADER, verifyGatewayPrincipal } = await import(moduleUrl('context/gateway-runtime'))
const { serveGatewayDocumentStore, documentOperationAccess } = await import(new URL(`packages/attachment/userdoc-gateway/${mode === 'src' ? 'src/server.ts' : 'lib/server.js'}`, repo))
const { documentResultSchemas } = await import(new URL(`packages/attachment/userdoc-gateway/${mode === 'src' ? 'src/protocol.ts' : 'lib/protocol.js'}`, repo))
const { GatewayPrincipalSigner } = await import(new URL(`gateway/${mode === 'src' ? 'src/principal.ts' : 'lib/principal.js'}`, repo))

const root = process.cwd(), home = join(root, 'home'), documents = join(home, 'documents')
await mkdir(documents, { recursive: true })
const bytes = text => new TextEncoder().encode(text)
const body = value => new ReadableStream({ start(controller) { controller.enqueue(value); controller.close() } })
const hash = value => createHash('sha256').update(value).digest('hex')
const limits = { maxFileBytes: null, maxFilesPerMessage: 8, maxMessageBytes: 32 * 1024 * 1024, maxInlineTextBytes: 1024,
  upload: { protocol: 'resumable-v1', chunkBytes: 64 * 1024, sessionTtlMs: 60_000, resumable: true } }
const engine = new LocalUserDocFs({ root: documents, limits,
  upload: { chunkBytes: limits.upload.chunkBytes, sessionTtlMs: 60_000, minFreeBytes: 0, maxConcurrent: 8, cleanupIntervalMs: 60_000, manifestMaxBytes: 64 * 1024 },
  sweepIntervalMs: 60_000, trashRetentionMs: 60_000,
})
engine.attach(); await engine.warm()
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const signer = new GatewayPrincipalSigner(privateKey, 'document-fixture', 60_000)
const runtimeIdentity = { kind: 'project', id: 41, generation: 1 }, token = 'fixture-document-runtime-token'
const users = new Map([7, 9, 10, 99].map(id => [id, {
  id, username: `member-${id}`, displayName: `Member ${id}`, role: id === 99 ? 'admin' : 'user', status: 'active',
  homePath: home, mustChangePassword: false, autoReviewEligible: false,
}]))
const scopes = new Map(), scope = actor => {
  const captured = { parentSessionId: `model-${actor}`, scopeId: randomUUID(), inputs: [], unverifiedHistory: false, primaryActorUserId: actor }
  scopes.set(`${captured.parentSessionId}:${captured.scopeId}`, Object.freeze({ actor, project: 41 }))
  return captured
}
const originalScope = scope(7), viewerScope = scope(9)
const lifetime = new AbortController(), work = new Set(), failures = [], received = [], finished = []
let ctx, credential, authorityGate, readGate
const forbidden = () => new UserDocError('Document access is no longer permitted.', DOCUMENT_PERMISSION_DENIED_CODE)
const metadata = createServer((request, response) => {
  const task = Promise.resolve().then(async () => {
    if (request.headers.authorization !== `Bearer ${token}`) { request.resume(); response.writeHead(401); response.end(); return }
    const pathname = new URL(request.url, 'http://runtime').pathname
    if (pathname.startsWith('/internal/runtime/documents/catalog/')) {
      const principal = verifyGatewayPrincipal(request.headers[GATEWAY_PRINCIPAL_HEADER], credential)
      assert.equal(principal.runtime.id, 41)
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(pathname.endsWith('/authorize') ? { version: 1, allowed: true } : { version: 1, accepted: 1 }))
      return
    }
    assert.equal(pathname, '/internal/runtime/documents/store')
    await serveGatewayDocumentStore(request, response, { maxMetadataBytes: 8192, signal: lifetime.signal,
      async withStore(envelope, signal, operation) {
        received.push({ kind: envelope.operation.kind, authority: envelope.authority.kind, header: request.headers[GATEWAY_PRINCIPAL_HEADER] !== undefined })
        if (authorityGate !== undefined && envelope.operation.kind === 'list') {
          authorityGate.entered.resolve(); await authorityGate.release.promise
        }
        let actor
        if (envelope.authority.kind === 'runtime') assert.equal(envelope.operation.kind, 'describe')
        else if (envelope.authority.kind === 'execution') {
          const registered = scopes.get(`${envelope.authority.sessionId}:${envelope.authority.scopeId}`)
          if (registered === undefined || registered.project !== runtimeIdentity.id) throw forbidden()
          actor = registered.actor
        } else {
          const principal = verifyGatewayPrincipal(request.headers[GATEWAY_PRINCIPAL_HEADER], credential)
          actor = principal.user.id
          if (principal.purpose !== undefined && !(principal.purpose === 'document-admin'
            && ['trash', 'restore', 'purge'].includes(envelope.operation.kind) && users.get(actor)?.role === 'admin')) throw forbidden()
          if (documentOperationAccess(envelope.operation) === 'write' && principal.scope.mode === 'ro' && principal.purpose !== 'document-admin') throw forbidden()
        }
        if (actor !== undefined && users.get(actor)?.status !== 'active') throw forbidden()
        return operation({ store: engine, signal,
          ...(actor === undefined ? {} : { ownerId: UserDocUploadOwnerId(`user:${actor}`) }),
          async finish(completed) { finished.push({ kind: completed.kind, actor }) },
        })
      },
    })
  })
  work.add(task)
  void task.then(() => { work.delete(task) }, error => { work.delete(task); failures.push(error); response.destroy() })
})

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
async function terminal(store, id) {
  const until = Date.now() + 10_000
  for (;;) {
    const current = await store.inspectUpload(id)
    if (current.state === 'complete' || current.state === 'failed') return current
    assert.ok(Date.now() < until, 'Document finalization must reach a terminal state')
    await setImmediate()
  }
}

try {
  await new Promise((resolve, reject) => { metadata.once('error', reject); metadata.listen(0, '127.0.0.1', resolve) })
  credential = { version: 1, gatewayUrl: `http://127.0.0.1:${metadata.address().port}`, organization: 'document-fixture',
    runtime: runtimeIdentity, token, principalPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) }
  const credentialFile = join(root, 'credential.json')
  await writeFile(credentialFile, JSON.stringify(credential), { mode: 0o600 })
  const authorityModule = join(root, 'fixture-authority.mjs')
  await writeFile(authorityModule, `export const name = 'fixture-document-authority'
export function apply(ctx) {
  const state = { scope: undefined }
  ctx.effect(() => ctx.provide('fixtureDocumentScope', state), 'fixture: execution selection')
  ctx.effect(() => ctx.provide('executionAuthority', { current: () => state.scope }), 'fixture: captured execution')
}
`)
  const configFile = join(root, 'cordis.yml')
  const plugins = [
    ['host/webserver', { host: '127.0.0.1', port: 0, compression: 'none' }],
    ['credentials/credentials-local', { path: join(root, 'credentials.yml'), watch: false }],
    ['client/connection'], ['context/gateway-runtime'], ['context/collaboration-gateway'],
    [authorityModule], ['attachment/userdoc-gateway', { documentRoot: documents, maxMetadataBytes: 8192, requestTimeoutMs: 10_000 }], ['host/userdoc-http'],
  ]
  await writeFile(configFile, plugins.map(([name, config]) => `- name: ${JSON.stringify(name.startsWith('/') ? name : moduleUrl(name).href)}${config === undefined ? '' : `\n  config: ${JSON.stringify(config)}`}`).join('\n') + '\n')
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialFile
  ctx = await boot('managed-document-store-fixture', configFile)
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  const state = ctx.get('fixtureDocumentScope'), store = ctx.userDocs
  state.scope = originalScope
  assert.equal(store.root, documents)
  assert.deepEqual(store.limits, limits)
  output({ operation: 'managed-document-bootstrap', rootConfirmed: true, limitsFromGateway: true })

  if (wrongPriority) {
    const transport = store.transport, capture = transport.capture.bind(transport)
    transport.capture = operation => {
      const principal = ctx.gatewayRuntime.interactive()
      return principal === undefined ? capture(operation) : {
        metadata: { kind: 'request' }, provider: ctx.get('executionAuthority'), principal,
      }
    }
  }
  const browser = (path, actor = 9, init) => {
    const headers = new Headers(init?.headers)
    headers.set(GATEWAY_PRINCIPAL_HEADER, signer.issue({ user: users.get(actor),
      scope: { kind: 'project', projectId: 41, projectName: 'Shared', mode: actor === 10 ? 'ro' : 'rw' }, runtime: runtimeIdentity,
    }))
    return fetch(`http://127.0.0.1:${ctx.webServer.port}${path}`, { ...init, headers })
  }
  ctx.effect(() => ctx.connection.http.handlePrefix('/api/document-owner-probe', async (_request, response) => {
    const viewer = ctx.gatewayRuntime.requireCurrent().claims.user.id
    const upload = await ctx.userDocs.beginUpload({ name: 'model-owner.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'model-owner' })
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ viewer, upload }))
  }, { authority: 'trusted-host' }), 'fixture: document owner probe')
  const probed = await browser('/api/document-owner-probe')
  assert.equal(probed.status, 200)
  const initial = await probed.json(), manifest = JSON.parse(await readFile(join(documents, '.upload-sessions', 'v1', initial.upload.uploadId, 'manifest.json'), 'utf8'))
  assert.equal(initial.viewer, 9)
  assert.equal(manifest.ownerId, 'user:7', 'captured execution must remain the upload owner')
  assert.equal(manifest.formatVersion, 2)
  assert.deepEqual(received.find(item => item.kind === 'beginUpload'), { kind: 'beginUpload', authority: 'execution', header: false })
  state.scope = viewerScope
  await assert.rejects(store.inspectUpload(initial.upload.uploadId), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
  state.scope = originalScope; await store.cancelUpload(initial.upload.uploadId)
  output({ operation: 'model-upload-owner', viewer: initial.viewer, owner: manifest.ownerId, formatVersion: manifest.formatVersion, foreignResume: 'denied' })

  const folder = await store.createDirectory(UserDocDirectoryId(''), 'work')
  const target = await store.resolveTarget({ name: 'payload.txt', directoryId: UserDocDirectoryId('') })
  const saved = await store.save(target, body(bytes('ordinary file bytes')))
  assert.equal(await readFile(saved.path, 'utf8'), 'ordinary file bytes')
  assert.equal(new TextDecoder().decode((await store.read(saved.docId)).data), 'ordinary file bytes')
  const opened = await store.openRead(saved.docId)
  assert.equal(await new Response(opened.body).text(), 'ordinary file bytes')
  assert.equal((await store.stat(saved.docId)).bytes, 19)
  assert.equal((await store.list()).length, 1)
  assert.equal((await store.listDirectory(UserDocDirectoryId(''))).documents.length, 1)
  assert.equal((await store.listDirectoryPage(UserDocDirectoryId(''), { limit: 1 })).totalDocuments, 1)
  assert.equal((await store.listDirectories()).length, 1)
  const moved = await store.move(saved.docId, folder.directoryId)
  assert.equal(moved.docId, 'work/payload.txt')
  const renamed = await store.renameDirectory(folder.directoryId, 'renamed')
  const current = (await store.listDirectory(renamed.directoryId)).documents[0]
  assert.equal(current.docId, 'renamed/payload.txt')
  await store.trash(current.docId)
  assert.equal((await store.listTrash()).length, 1)
  assert.equal((await store.listTrashPage({ limit: 1 })).totalDocuments, 1)
  const restored = await store.restore(current.docId, UserDocDirectoryId(''), 'restored.txt')
  assert.equal(await readFile(restored.path, 'utf8'), 'ordinary file bytes')
  await store.trash(restored.docId); await store.purge(restored.docId)
  await assert.rejects(stat(restored.path), { code: 'ENOENT' })
  await store.removeDirectory(renamed.directoryId)
  const hard = await store.save(await store.resolveTarget({ name: 'hard.txt', directoryId: UserDocDirectoryId('') }), body(bytes('hard delete')))
  await store.remove(hard.docId)
  assert.deepEqual(await store.list(), [])
  output({ operation: 'managed-files-and-directories', readBytes: 'ordinary file bytes', move: 'work/payload.txt', rename: 'renamed/payload.txt', restoredAndPurged: true, hardRemoved: true })

  const content = bytes('resumable bytes'), digest = hash(content)
  const upload = await store.beginUpload({ name: 'upload.txt', directoryId: UserDocDirectoryId(''), bytes: content.length, fingerprint: 'resumable' })
  await store.writeUploadChunk(upload.uploadId, { index: 0, start: 0, end: content.length - 1, total: content.length, sha256: digest, body: body(content) })
  assert.equal((await store.inspectUpload(upload.uploadId)).receivedBytes, content.length)
  await store.completeUpload(upload.uploadId, digest)
  const completed = await terminal(store, upload.uploadId)
  assert.equal(completed.state, 'complete')
  assert.equal(await readFile(completed.ref.path, 'utf8'), 'resumable bytes')
  await store.remove(completed.ref.docId)
  const empty = await store.beginUpload({ name: 'empty.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: 'empty' })
  await store.completeUpload(empty.uploadId, hash(new Uint8Array(0)))
  const emptyCompleted = await terminal(store, empty.uploadId)
  assert.equal(emptyCompleted.state, 'complete'); assert.equal((await stat(emptyCompleted.ref.path)).size, 0)
  await store.remove(emptyCompleted.ref.docId)
  output({ operation: 'managed-resumable', bytes: completed.receivedBytes, emptyBytes: emptyCompleted.receivedBytes, states: [completed.state, emptyCompleted.state] })

  const large = new Uint8Array(2 * 1024 * 1024).fill(137)
  let offset = 0
  const largeRef = await store.save(await store.resolveTarget({ name: 'large.bin', directoryId: UserDocDirectoryId('') }), new ReadableStream({
    pull(controller) {
      if (offset === large.length) { controller.close(); return }
      controller.enqueue(large.subarray(offset, offset + 64 * 1024)); offset += 64 * 1024
    },
  }))
  assert.equal((await store.stat(largeRef.docId)).bytes, large.length)
  assert.equal(hash((await store.read(largeRef.docId)).data), hash(large))
  await store.remove(largeRef.docId)
  output({ operation: 'managed-streaming', bytes: large.length, metadataLimit: 8192, identical: true })

  for (let index = 0; index < 100; index += 1) await writeFile(join(documents, `bulk-${String(index).padStart(3, '0')}.txt`), 'external file')
  const page = await store.listDirectoryPage(UserDocDirectoryId(''), { limit: 1, sort: 'name-asc' })
  assert.equal(page.totalDocuments, 100); assert.equal(page.documents.length, 1)
  await assert.rejects(store.list(), { code: 'DOCUMENT_STORE_UNAVAILABLE' })
  for (let index = 0; index < 100; index += 1) await rm(join(documents, `bulk-${String(index).padStart(3, '0')}.txt`))
  output({ operation: 'managed-paging', total: page.totalDocuments, pageSize: page.documents.length, oversizedFullListing: 'refused' })

  state.scope = undefined
  const listed = await browser('/api/documents', 10)
  assert.equal(listed.status, 200); await listed.json()
  const readonly = await browser('/api/documents/uploads', 10, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, name: 'refused.txt', directory: '', bytes: 1, fingerprint: 'readonly' }) })
  assert.equal(readonly.status, 403); await readonly.json()
  output({ operation: 'managed-readonly-member', listing: listed.status, upload: readonly.status })

  state.scope = originalScope
  authorityGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  const before = finished.length, refused = store.list()
  const refusedOutcome = refused.then(() => assert.fail('Revoked actor must be refused'), error => error)
  try {
    await authorityGate.entered.promise
    users.get(7).status = 'disabled'; state.scope = viewerScope
    authorityGate.release.resolve()
    assert.equal((await refusedOutcome).code, 'DOCUMENT_PERMISSION_DENIED')
    assert.equal(finished.length, before)
  } finally { authorityGate.release.resolve(); authorityGate = undefined; users.get(7).status = 'active'; state.scope = originalScope }
  output({ operation: 'managed-queued-authority', originalActor: 7, laterViewer: 9, disabledOriginal: 'denied', backendOperation: false })

  const handoff = await store.save(await store.resolveTarget({ name: 'handoff.txt', directoryId: UserDocDirectoryId('') }), body(bytes('held stream bytes')))
  const openRead = engine.openRead.bind(engine)
  readGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  engine.openRead = async id => {
    const opened = await openRead(id)
    if (id !== handoff.docId) return opened
    const reader = opened.body.getReader(), gate = readGate
    return { ref: opened.ref, body: new ReadableStream({
      async pull(controller) {
        gate.entered.resolve(); await gate.release.promise
        const next = await reader.read()
        if (next.done) { reader.releaseLock(); controller.close() } else controller.enqueue(next.value)
      },
      async cancel(reason) { gate.release.resolve(); try { await reader.cancel(reason) } finally { reader.releaseLock() } },
    }) }
  }
  const clientOpenRead = store.openRead.bind(store), handed = Promise.withResolvers()
  store.openRead = async id => {
    const opened = await clientOpenRead(id)
    if (id === handoff.docId) handed.resolve()
    return opened
  }
  state.scope = undefined
  const downloading = browser(`/api/documents/content?id=${encodeURIComponent(handoff.docId)}`)
  await readGate.entered.promise
  await handed.promise
  const entry = [...ctx.loader.entries()].find(value => value.options.name.includes('/attachment/userdoc-gateway/'))
  assert.ok(entry)
  let stopped = false
  const stopping = entry.fiber.dispose().then(() => { stopped = true })
  const removed = await browser('/api/documents')
  assert.equal(removed.status, 404); await removed.text()
  assert.equal(stopped, false, 'document consumer must drain its handed-off response before provider withdrawal finishes')
  readGate.release.resolve()
  const downloaded = await downloading
  assert.equal(downloaded.status, 200)
  assert.equal(await downloaded.text(), 'held stream bytes')
  await stopping
  output({ operation: 'managed-provider-unload', routeRemoved: removed.status, responseBytes: 'held stream bytes', consumerDrained: true })
  const called = received.length
  await assert.rejects(async () => store.list())
  assert.equal(received.length, called)
  assert.deepEqual([...new Set(finished.map(item => item.kind))].sort(), Object.keys(documentResultSchemas).sort())
  output({ operation: 'managed-method-coverage', methods: Object.keys(documentResultSchemas).length, stoppedReference: 'refused' })
} finally {
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  authorityGate?.release.resolve(); readGate?.release.resolve()
  const errors = []
  if (ctx !== undefined) { try { await ctx.fiber.dispose() } catch (error) { errors.push(error) } }
  lifetime.abort(); metadata.closeAllConnections()
  const running = await Promise.allSettled([...work])
  errors.push(...running.filter(value => value.status === 'rejected').map(value => value.reason))
  try { await engine.dispose() } catch (error) { errors.push(error) }
  if (metadata.listening) await new Promise((resolve, reject) => metadata.close(error => error ? reject(error) : resolve()))
  errors.push(...failures)
  if (errors.length > 0) throw new AggregateError(errors, 'Managed document fixture cleanup failed')
}
