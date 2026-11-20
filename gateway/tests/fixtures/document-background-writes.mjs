/** Real HTTP and filesystem replay of the compiled broker's maintenance writer lifetime. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOCUMENT_STORE_UNAVAILABLE_CODE, UserDocError } from '@deepseek-ai/dsh-userdoc'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'
import { readManagedDataPaths } from '@deepseek-ai/dsh-managed-data'
import { loadConfig } from '../../lib/config.js'
import { LocalDocumentBroker } from '../../lib/documents-local.js'
import { DocumentProjectionDelivery } from '../../lib/document-projection-delivery.js'
import { DOCUMENT_TRANSFER_UPLOADS_PATH, DocumentTransferError } from '../../lib/document-transfer.js'
import { GatewayPrincipalSigner } from '../../lib/principal.js'

function barrier() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const root = await mkdtemp(join(tmpdir(), 'hgw-background-writes-'))
const lifetime = new AbortController(), deadline = setTimeout(() => lifetime.abort(new Error('Document replay deadline')), 60_000)
async function wait(promise) {
  lifetime.signal.throwIfAborted()
  let aborted
  const cancel = new Promise((_, reject) => {
    aborted = () => reject(lifetime.signal.reason)
    lifetime.signal.addEventListener('abort', aborted, { once: true })
  })
  try { return await Promise.race([promise, cancel]) }
  finally { lifetime.signal.removeEventListener('abort', aborted) }
}

const entered = barrier(), release = barrier(), finished = barrier()
const catalogEntered = barrier(), catalogRelease = barrier()
const acknowledgementInterrupted = barrier(), failedDeliveryDrained = barrier()
const cursorEntered = barrier(), cursorRelease = barrier(), concurrentDeliveryQueued = barrier()
const pendingRequests = []
const originalDelivery = DocumentProjectionDelivery.prototype.run
let concurrencyPhase = false, queuedDeliveries = 0
DocumentProjectionDelivery.prototype.run = function (operation) {
  const pending = originalDelivery.call(this, operation)
  if (concurrencyPhase && ++queuedDeliveries === 2) concurrentDeliveryQueued.resolve()
  return pending
}
let broker, server, failure
try {
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'),
    HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
    HGW_STATE_ROOT: join(root, 'state'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
  const user = { id: 7, username: 'member', displayName: 'Member', role: 'user', status: 'active',
    homePath: join(root, 'home'), mustChangePassword: false, autoReviewEligible: false }
  await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
  await mkdir(user.homePath, { recursive: true, mode: 0o700 })
  const { privateKey } = generateKeyPairSync('ed25519')
  let open = false, hold = false, writers = 0, catalogCalls = 0, cursorReads = 0
  let interruptAcknowledgement = false, interruptedAcknowledgement = false
  let ownerExists = true
  let holdCursor = false
  const projectionOrder = []
  const accessListeners = new Set()
  let cursor = { sequence: 0, ordinal: 0 }
  broker = new LocalDocumentBroker({ cfg, users: { async getById(id) { return ownerExists && id === user.id ? user : null } },
    instances: { async generationOf() { return 1 } }, projects: {}, collaboration: {},
    principals: new GatewayPrincipalSigner(privateKey, 'background-writes', 60_000), organizationId: 'background-writes',
    accessMonitor: { available: true, async synchronize() {}, subscribe(listener) {
      accessListeners.add(listener); return () => { accessListeners.delete(listener) }
    } },
    catalog: { async projection({ payload }) {
      if (payload.batch !== undefined) {
        if (concurrencyPhase) projectionOrder.push('commit')
        catalogCalls += 1
        catalogEntered.resolve()
        await wait(catalogRelease.promise)
        cursor = payload.batch.next
        if (catalogCalls === 1) interruptAcknowledgement = true
      } else {
        cursorReads += 1
        if (concurrencyPhase) projectionOrder.push('cursor')
        if (holdCursor) {
          holdCursor = false
          const captured = { ...cursor }
          cursorEntered.resolve()
          await wait(cursorRelease.promise)
          return { version: 1, cursor: captured }
        }
      }
      return { version: 1, cursor }
    } },
    writes: {
      async retain(operation) {
        if (interruptAcknowledgement) {
          interruptAcknowledgement = false; interruptedAcknowledgement = true
          acknowledgementInterrupted.resolve()
          throw new UserDocError('Interrupted document acknowledgement.', DOCUMENT_STORE_UNAVAILABLE_CODE)
        }
        const held = hold && writers > 0
        writers += 1
        try {
          if (held) { entered.resolve(); await wait(release.promise) }
          await operation()
        } finally {
          writers -= 1
          if (held && writers === 0) finished.resolve()
          if (interruptedAcknowledgement && writers === 0) failedDeliveryDrained.resolve()
        }
      },
      async admit(operation) {
        if (!open) throw new UserDocError('Document storage is unavailable during maintenance.', DOCUMENT_STORE_UNAVAILABLE_CODE)
        writers += 1
        const held = hold
        try {
          if (held) { entered.resolve(); await wait(release.promise) }
          await operation()
        } finally {
          writers -= 1
          if (held && writers === 0) finished.resolve()
          if (interruptedAcknowledgement && writers === 0) failedDeliveryDrained.resolve()
        }
      },
    },
  })
  const failures = [], transcript = []
  server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url, 'http://fixture').pathname
      const input = { user, request, scope: { kind: 'personal' }, signal: lifetime.signal }
      const result = pathname === '/fixture/catalog-notification'
        ? Response.json(await broker.reconcileRuntimeCatalog({ subject: { organizationId: 'background-writes', target: { kind: 'user', id: user.id } },
          principal: { user, scope: { kind: 'personal' } }, payload: { version: 1, documents: [] } }))
        : pathname === '/api/documents/scope'
        ? await broker.serveScope({ ...input, operation: 'list' })
        : await broker.serveUpload({ ...input, pathname })
      assert(result instanceof Response)
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text())
    })().catch(error => {
      if (error instanceof DocumentTransferError) {
        response.writeHead(error.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: error.code, message: error.message }))
      } else { failures.push(error); response.destroy(error) }
    })
  })
  await wait(new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  }))
  const base = `http://127.0.0.1:${server.address().port}`
  const bytes = Buffer.from('background publication'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const metadata = { version: 1, name: 'verified.txt', directory: '', bytes: bytes.length, fingerprint: 'background-replay' }
  const call = (path, init) => fetch(base + path, { ...init, signal: lifetime.signal })
  const begin = () => call(DOCUMENT_TRANSFER_UPLOADS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metadata) })
  const cold = await begin()
  assert.equal(cold.status, 503); await cold.arrayBuffer()
  await assert.rejects(stat(join(user.homePath, 'documents')), { code: 'ENOENT' })
  transcript.push({ case: 'cold-storage-maintenance', status: cold.status, created: false })
  open = true
  const created = await begin(); assert.equal(created.status, 200)
  const { uploadId } = await created.json()
  const chunk = await call(`${DOCUMENT_TRANSFER_UPLOADS_PATH}/${uploadId}/chunks/0`, { method: 'PUT', headers: {
    'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length),
    'x-dsh-chunk-sha256': sha256 }, body: bytes })
  assert.equal(chunk.status, 200); await chunk.arrayBuffer()
  hold = true
  const accepted = await call(`${DOCUMENT_TRANSFER_UPLOADS_PATH}/${uploadId}/complete`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, sha256 }) })
  assert.equal(accepted.status, 202); assert.equal((await accepted.json()).state, 'verifying')
  await wait(entered.promise); assert.equal(writers, 1)
  transcript.push({ case: 'asynchronous-upload', status: accepted.status, writersAfterResponse: writers })
  const files = readManagedDataPaths(join(cfg.stateRoot, 'document-identity-roots.jsonl')).find(row => row.owner.endsWith('/files'))
  assert(files !== undefined)
  const manifestPath = join(files.path, '.upload-sessions', 'v1', uploadId, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, expiresAt: 1 }) + '\n')
  const expiredVerification = await call(`${DOCUMENT_TRANSFER_UPLOADS_PATH}/${uploadId}`)
  assert.equal(expiredVerification.status, 202); assert.equal((await expiredVerification.json()).state, 'verifying')
  transcript.push({ case: 'accepted-verification-expiry', status: expiredVerification.status, state: 'verifying', writers })
  open = false
  release.resolve(); await wait(finished.promise)
  assert.equal(writers, 0)
  const inspected = await call(`${DOCUMENT_TRANSFER_UPLOADS_PATH}/${uploadId}`)
  assert.equal(inspected.status, 503); assert.equal((await inspected.json()).error.code, 'DOCUMENT_CATALOG_UNAVAILABLE')
  const contents = await readFile(join(user.homePath, 'documents', 'verified.txt'), 'utf8')
  assert.equal(contents, bytes.toString()); assert.equal(failures.length, 0)
  transcript.push({ case: 'maintenance-drain', writers, status: inspected.status, contents })
  open = true; hold = false
  const listed = await call('/api/documents/scope')
  assert.equal(listed.status, 200); await listed.arrayBuffer()
  await wait(catalogEntered.promise)
  assert.equal(writers, 1)
  transcript.push({ case: 'read-catalog-writer', status: listed.status, writersAfterResponse: writers })
  open = false
  const closedListing = await call('/api/documents/scope')
  assert.equal(closedListing.status, 200); await closedListing.arrayBuffer()
  assert.equal(catalogCalls, 1)
  transcript.push({ case: 'maintenance-catalog-read', status: closedListing.status, catalogCalls, pendingWriters: writers })
  catalogRelease.resolve()
  await wait(acknowledgementInterrupted.promise); await wait(failedDeliveryDrained.promise)
  assert.equal(writers, 0)
  transcript.push({ case: 'catalog-acknowledgement-interrupted', delivered: catalogCalls, writers })
  open = true
  const acknowledged = await call(`${DOCUMENT_TRANSFER_UPLOADS_PATH}/${uploadId}`)
  assert.equal(acknowledged.status, 200); assert.equal((await acknowledged.json()).state, 'complete')
  transcript.push({ case: 'catalog-acknowledged', status: acknowledged.status, state: 'complete' })
  let acknowledgedReads = cursorReads
  const retriedListing = await call('/api/documents/scope')
  assert.equal(retriedListing.status, 200); await retriedListing.arrayBuffer()
  const drainedNotification = await call('/fixture/catalog-notification', { method: 'POST' })
  assert.equal(drainedNotification.status, 200); await drainedNotification.arrayBuffer()
  assert.equal(cursorReads, acknowledgedReads)
  await writeFile(join(user.homePath, 'documents', 'concurrent.txt'), 'concurrent metadata')
  concurrencyPhase = true; holdCursor = true
  const concurrentListing = await call('/api/documents/scope')
  assert.equal(concurrentListing.status, 200)
  const concurrentDocuments = await concurrentListing.json()
  const concurrentIdentity = concurrentDocuments.documents.find(document => document.docId === 'concurrent.txt')
  assert(concurrentIdentity !== undefined)
  await wait(cursorEntered.promise)
  const notification = call('/fixture/catalog-notification', { method: 'POST' })
  const notificationOutcome = Promise.allSettled([notification])
  pendingRequests.push(notificationOutcome)
  await wait(concurrentDeliveryQueued.promise)
  assert.deepEqual(projectionOrder, ['cursor'])
  cursorRelease.resolve()
  const [notified] = await notificationOutcome
  assert.equal(notified.status, 'fulfilled'); assert.equal(notified.value.status, 200)
  await notified.value.arrayBuffer()
  assert.deepEqual(projectionOrder, ['cursor', 'commit'])
  const concurrentVerified = await call('/api/documents/scope')
  assert.equal(concurrentVerified.status, 200)
  const verifiedIdentity = (await concurrentVerified.json()).documents.find(document => document.docId === 'concurrent.txt')
  assert.deepEqual(verifiedIdentity, concurrentIdentity)
  const finalNotification = await call('/fixture/catalog-notification', { method: 'POST' })
  assert.equal(finalNotification.status, 200); await finalNotification.arrayBuffer()
  assert.deepEqual(projectionOrder, ['cursor', 'commit'])
  transcript.push({ case: 'concurrent-browser-runtime-delivery', listing: concurrentListing.status,
    notification: notified.value.status, projectionOrder, identityPreserved: true })
  concurrencyPhase = false; acknowledgedReads = cursorReads
  const originalDispose = LocalUserDocFs.prototype.dispose
  let retiredEngine
  LocalUserDocFs.prototype.dispose = async function () { await originalDispose.call(this); retiredEngine = this }
  try {
    ownerExists = false
    assert.equal(accessListeners.size, 1)
    await wait(Promise.all([...accessListeners].map(listener => listener({ userId: user.id }))))
    assert(retiredEngine instanceof LocalUserDocFs)
    await assert.rejects(retiredEngine.list(), /disposed/u)
    assert.equal(await readFile(join(user.homePath, 'documents', 'verified.txt'), 'utf8'), contents)
    transcript.push({ case: 'scope-removed', closed: true, contentsPreserved: true, writers })
  } finally { LocalUserDocFs.prototype.dispose = originalDispose }
  await broker.dispose()
  assert.equal(accessListeners.size, 0)
  assert.equal(cursorReads, acknowledgedReads)
  assert.equal(writers, 0)
  transcript.push({ case: 'catalog-drained', writers, delivered: catalogCalls })
  const output = transcript.map(event => JSON.stringify(event)).join('\n') + '\n'
  assert.equal(output, await readFile(new URL('../expected/document-background-writes.jsonl', import.meta.url), 'utf8'))
  process.stdout.write(output)
} catch (error) {
  failure = error
  throw error
} finally {
  concurrencyPhase = false
  DocumentProjectionDelivery.prototype.run = originalDelivery
  clearTimeout(deadline); release.resolve(); catalogRelease.resolve(); cursorRelease.resolve(); lifetime.abort()
  server?.closeAllConnections()
  const closed = await Promise.allSettled([
    ...pendingRequests,
    ...(broker === undefined ? [] : [broker.dispose()]),
    ...(server === undefined || !server.listening ? [] : [new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })]),
  ])
  await rm(root, { recursive: true, force: true })
  const errors = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length > 0) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'Document replay cleanup failed')
}
