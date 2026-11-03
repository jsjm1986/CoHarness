/** Keyless transfer through the real runtime authentication, document HTTP and storage plugins. */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Document transfer fixture requires src or lib')
const unownedHttp = process.argv[3] === 'unowned-http'
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const gatewayArtifact = mode === 'src' ? 'src' : 'lib'
const gatewayExtension = mode === 'src' ? 'ts' : 'js'
const { boot } = await import(new URL(`../../../packages/boot/app-boot/${artifact}`, import.meta.url))
const { GatewayPrincipalSigner } = await import(new URL(`../../${gatewayArtifact}/principal.${gatewayExtension}`, import.meta.url))
const { createDocumentTransferPlanHandler, createDocumentTransferCommitHandler, createDocumentTransferHandler } =
  await import(new URL(`../../${gatewayArtifact}/document-transfer.${gatewayExtension}`, import.meta.url))
const { UserDocDirectoryId, UserDocUploadId, UserDocUploadOwnerId } = await import(new URL(`../../../packages/attachment/userdoc/${artifact}`, import.meta.url))

const root = process.cwd(), contexts = [], requests = [], consumerStops = []
let catalogGate
const metadataTasks = new Set(), metadataFailures = []
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const signer = new GatewayPrincipalSigner(privateKey, 'fixture-organization', 30_000)
const realNow = Date.now
let clockOffset = 0, active = true, membership = true, revokeAfterBegin = false
Date.now = () => realNow() + clockOffset
const user = {
  id: 7, username: 'copy-owner', displayName: 'Copy owner', role: 'user', status: 'active',
  homePath: join(root, 'source'), mustChangePassword: false, autoReviewEligible: false,
}
const other = {
  ...user, id: 9, username: 'copy-reader', displayName: 'Copy reader', homePath: join(root, 'personal-peer'),
}
const metadata = createServer((req, res) => {
  req.resume()
  const header = req.headers['x-dsh-gateway-principal']
  try {
    assert.equal(req.headers.authorization, 'Bearer fixture-runtime-token')
    const principal = signer.verify(header)
    assert.ok(principal.user.id === user.id || principal.user.id === other.id)
    if (req.url === '/internal/runtime/documents/catalog/sync' && principal.runtime.kind === 'user' && catalogGate !== undefined) {
      const gate = catalogGate
      gate.actor = principal.user.id
      gate.entered.resolve(undefined)
      const task = (async () => {
        await gate.release.promise
        await writeFile(join(root, 'catalog-delivered.json'), JSON.stringify({ actor: gate.actor }))
        gate.delivered = true
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: 1, accepted: 1 }))
      })().catch(error => {
        metadataFailures.push(error)
        res.destroy(error)
      })
      metadataTasks.add(task)
      void task.then(() => metadataTasks.delete(task))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: 1, accepted: 1 }))
  } catch {
    res.writeHead(403); res.end()
  }
})

async function runtime(label, identity, collaboration = true, sharedDocuments) {
  const base = join(root, label), documents = sharedDocuments ?? join(base, 'documents'), credential = join(base, 'credential.json')
  await mkdir(base, { recursive: true })
  await writeFile(credential, JSON.stringify({
    version: 1, gatewayUrl: `http://127.0.0.1:${metadata.address().port}`,
    organization: 'fixture-organization', runtime: identity, token: 'fixture-runtime-token',
    principalPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }), { mode: 0o600 })
  const plugins = [
    ['host/webserver', { host: '127.0.0.1', port: 0, compression: 'none' }],
    ['credentials/credentials-local', { path: join(base, 'credentials.yml'), watch: false }],
    ['client/connection'], ['context/gateway-runtime'],
    ...(identity.kind === 'project' && collaboration ? [['context/collaboration-gateway']] : []),
    ['attachment/userdoc-local', { uploadRoot: documents, uploadMinFreeBytes: 0 }],
    ['host/userdoc-http'],
  ]
  const config = join(base, 'cordis.yml')
  const unownedModule = join(base, 'unowned-http.mjs')
  if (unownedHttp) {
    await writeFile(unownedModule, `import { handleUserDocHttp, userDocHttpHost, USERDOC_HTTP_PATH } from ${JSON.stringify(new URL(`../../../packages/host/userdoc-http/${artifact}`, import.meta.url).href)}
export const name = 'unowned-http'
export const inject = ['connection', 'userDocs']
export function apply(ctx) {
  const host = userDocHttpHost(ctx)
  ctx.connection.http.handlePrefix(USERDOC_HTTP_PATH, (req, res) => handleUserDocHttp(host, req, res), { authority: 'trusted-host' })
}
`)
  }
  await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
    name: unownedHttp && path === 'host/userdoc-http'
      ? pathToFileURL(unownedModule).href
      : new URL(`../../../packages/${path}/${artifact}`, import.meta.url).href,
    ...(options === undefined ? {} : { config: options }),
  }))))
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = credential
  const ctx = await boot('document-transfer-fixture', config)
  contexts.push(ctx)
  ctx.on('connection/request', async (request, next) => {
    requests.push(`${label}:${request.method}:${request.pathname}`)
    if (label === 'source' && request.pathname === '/api/documents/content') clockOffset += 60_000
    if (label === 'target' && revokeAfterBegin && request.method === 'POST' && request.pathname === '/api/documents/uploads') {
      membership = false
    }
    await next()
  })
  return { ctx, port: ctx.webServer.port, documents }
}

try {
  await new Promise((resolve, reject) => {
    metadata.once('error', reject)
    metadata.listen(0, '127.0.0.1', resolve)
  })
  const source = await runtime('source', { kind: 'user', id: 7, generation: 1 })
  const target = await runtime('target', { kind: 'project', id: 41, generation: 1 })
  const personalRuntimes = new Map([[user.id, source]])
  const allocatedRuntimes = new Map()
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  const dependencies = {
    users: { getById: async id => id === user.id ? { ...user, status: active ? 'active' : 'disabled' } : id === other.id ? other : null },
    projects: { getById: async id => ({ id, name: 'Shared project', path: join(root, 'target'), members: [], memberCount: 1, origin: 'admin' }) },
    collaboration: { projectForUser: async (id, actorId) => membership && id === 41 && (actorId === user.id || actorId === other.id)
      ? { projectId: 41, name: 'Shared project', path: join(root, 'target'), mode: actorId === other.id ? 'ro' : 'rw', administrator: false } : null },
    instances: { ensureRunning: async value => {
      const instance = 'username' in value ? value.runtimeId === undefined ? personalRuntimes.get(value.id) : allocatedRuntimes.get(value.runtimeId) : target
      assert.ok(instance, 'personal transfers must use their authenticated account runtime')
      return { port: instance.port, generation: value.runtimeId === undefined ? 1 : 2,
        ...(value.runtimeId === undefined ? {} : { runtimeId: value.runtimeId }) }
    } },
    principals: signer,
  }
  const subject = { organizationId: 'fixture-organization', target: { kind: 'user', id: 7 }, generation: 1 }
  const principal = signer.verify(signer.issue({ user, scope: { kind: 'personal' }, runtime: { ...subject.target, generation: 1 } }))
  const plan = createDocumentTransferPlanHandler(dependencies), commit = createDocumentTransferCommitHandler(dependencies)
  const transfer = createDocumentTransferHandler(dependencies)
  const body = text => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
  const save = async (name, text) => source.ctx.userDocs.save(await source.ctx.userDocs.resolveTarget({ directoryId: UserDocDirectoryId(''), name }), body(text))
  const ref = await save('report.txt', 'shared copy bytes')
  const payload = { version: 1, source: { kind: 'personal' }, target: { kind: 'project', projectId: 41 }, documents: [{ docId: ref.docId }] }
  const planned = await plan({ subject, principal, payload, signal: new AbortController().signal })
  const input = { request: {}, subject, principal, payload: { ...payload, planId: planned.planId }, signal: new AbortController().signal }
  await assert.rejects(commit({ ...input, principal: { ...principal, user: { ...principal.user, id: 8 } } }), { code: 'DOCUMENT_TRANSFER_PLAN_EXPIRED' })
  const copied = await commit(input)
  assert.equal(copied.items[0].status, 'copied', JSON.stringify(copied.items))
  assert.equal(await readFile(join(target.documents, copied.items[0].target.docId), 'utf8'), 'shared copy bytes')
  assert.ok(clockOffset >= 60_000)
  process.stdout.write(`${JSON.stringify({ operation: 'copy-plan', foreignActor: 'denied', originalActor: 'copied', bytes: 'shared copy bytes', expiredInitialPrincipal: true })}\n`)

  const blocked = await save('blocked.txt', 'must remain unpublished')
  revokeAfterBegin = true
  const before = requests.length
  const denied = await transfer({ ...input, payload: { ...payload, documents: [{ docId: blocked.docId }] } })
  assert.equal(denied.items[0].status, 'failed')
  assert.equal(denied.items[0].error.code, 'COLLABORATION_FORBIDDEN')
  assert.equal(requests.slice(before).some(request => request.includes('/chunks/')), false)
  assert.deepEqual((await target.ctx.userDocs.list()).map(row => row.name), ['report.txt'])
  process.stdout.write(`${JSON.stringify({ operation: 'copy-revocation', status: 'denied', furtherChunks: false, newPublication: false })}\n`)

  membership = true; active = false; revokeAfterBegin = false
  const disabled = await transfer({ ...input, payload: { ...payload, documents: [{ docId: blocked.docId }] } })
  assert.equal(disabled.items[0].status, 'failed')
  assert.equal(disabled.items[0].error.code, 'COLLABORATION_FORBIDDEN')
  process.stdout.write(`${JSON.stringify({ operation: 'disabled-actor', status: 'denied', published: (await target.ctx.userDocs.list()).map(row => row.name) })}\n`)

  active = true
  const signedFetch = (runtime, runtimeIdentity, pathname, init, actor = user, purpose) => {
    const headers = new Headers(init?.headers)
    headers.set('x-dsh-gateway-principal', signer.issue({ user: actor,
      scope: runtimeIdentity.kind === 'user' ? { kind: 'personal' } : { kind: 'project', projectId: 41, projectName: 'Shared project', mode: actor.id === other.id ? 'ro' : 'rw' },
      runtime: runtimeIdentity,
      ...(purpose === undefined ? {} : { purpose }),
    }))
    return fetch(`http://127.0.0.1:${runtime.port}${pathname}`, { ...init, headers })
  }
  const personalIdentity = { kind: 'user', id: 7, generation: 1 }
  assert.equal(source.ctx.get('collaboration'), undefined)
  const begun = await signedFetch(source, personalIdentity, '/api/documents/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, name: 'personal-owner.txt', directory: '', bytes: 1, fingerprint: 'personal-owner', ownerId: 'user:9' }),
  })
  assert.equal(begun.status, 200)
  const upload = await begun.json()
  const stored = JSON.parse(await readFile(join(source.documents, '.upload-sessions', 'v1', upload.uploadId, 'manifest.json'), 'utf8'))
  assert.equal(stored.formatVersion, 2, 'authenticated personal uploads must retain their original actor')
  assert.equal(stored.ownerId, 'user:7')
  await assert.rejects(source.ctx.userDocs.inspectUpload(UserDocUploadId(upload.uploadId)), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
  await assert.rejects(source.ctx.userDocs.inspectUpload(UserDocUploadId(upload.uploadId), undefined, UserDocUploadOwnerId('user:9')), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
  const cancelled = await signedFetch(source, personalIdentity, `/api/documents/uploads/${upload.uploadId}`, { method: 'DELETE' })
  assert.equal(cancelled.status, 204)
  process.stdout.write(`${JSON.stringify({ operation: 'personal-upload-owner', formatVersion: stored.formatVersion,
    ownerId: stored.ownerId, collaborationService: source.ctx.get('collaboration') !== undefined })}\n`)

  const legacy = await source.ctx.userDocs.beginUpload({ name: 'legacy.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'legacy-owner' })
  const legacyPath = join(source.documents, '.upload-sessions', 'v1', String(legacy.uploadId), 'manifest.json')
  const beforeLegacy = await readFile(legacyPath, 'utf8')
  assert.equal(JSON.parse(beforeLegacy).formatVersion, 1)
  const refusedLegacy = await signedFetch(source, personalIdentity, `/api/documents/uploads/${String(legacy.uploadId)}`)
  assert.equal(refusedLegacy.status, 404)
  assert.equal((await refusedLegacy.json()).error.code, 'DOCUMENT_UPLOAD_NOT_FOUND')
  const restarted = await signedFetch(source, personalIdentity, '/api/documents/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, name: 'legacy.txt', directory: '', bytes: 1, fingerprint: 'legacy-owner' }),
  })
  assert.equal(restarted.status, 200)
  const replacement = await restarted.json()
  assert.notEqual(replacement.uploadId, String(legacy.uploadId))
  const afterLegacy = await readFile(legacyPath, 'utf8')
  assert.equal(afterLegacy, beforeLegacy)
  const cancelledReplacement = await signedFetch(source, personalIdentity, `/api/documents/uploads/${replacement.uploadId}`, { method: 'DELETE' })
  assert.equal(cancelledReplacement.status, 204)
  await source.ctx.userDocs.cancelUpload(legacy.uploadId)
  process.stdout.write(`${JSON.stringify({ operation: 'personal-ownerless-resume', status: refusedLegacy.status,
    newSession: replacement.uploadId !== String(legacy.uploadId), legacyUnchanged: afterLegacy === beforeLegacy })}\n`)

  const copiedBack = await transfer({ ...input, payload: { version: 1,
    source: { kind: 'project', projectId: 41 }, target: { kind: 'personal' },
    documents: [{ docId: copied.items[0].target.docId }],
  } })
  assert.equal(copiedBack.items[0].status, 'copied')
  const copiedBytes = await readFile(join(source.documents, copiedBack.items[0].target.docId), 'utf8')
  assert.equal(copiedBytes, 'shared copy bytes')
  const personalManifests = []
  for (const name of await readdir(join(source.documents, '.upload-sessions', 'v1'))) {
    if (!/^[0-9a-f-]{36}$/u.test(name)) continue
    personalManifests.push(JSON.parse(await readFile(join(source.documents, '.upload-sessions', 'v1', name, 'manifest.json'), 'utf8')))
  }
  const completedCopy = personalManifests.find(item => item.ref?.docId === copiedBack.items[0].target.docId)
  assert.equal(completedCopy?.formatVersion, 2)
  assert.equal(completedCopy?.ownerId, 'user:7')
  process.stdout.write(`${JSON.stringify({ operation: 'project-to-personal-copy', status: copiedBack.items[0].status,
    bytes: copiedBytes, formatVersion: completedCopy.formatVersion, ownerId: completedCopy.ownerId })}\n`)

  const peerIdentity = { kind: 'user', id: other.id, generation: 1 }
  const peer = await runtime('personal-peer', peerIdentity)
  personalRuntimes.set(other.id, peer)
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  const peerPrincipal = signer.verify(signer.issue({ user: other, scope: { kind: 'personal' }, runtime: peerIdentity }))
  const peerCopy = await transfer({ ...input,
    subject: { ...subject, target: { kind: 'user', id: other.id } }, principal: peerPrincipal,
    payload: { version: 1, source: { kind: 'project', projectId: 41 }, target: { kind: 'personal' },
      documents: [{ docId: copied.items[0].target.docId }],
    },
  })
  assert.equal(peerCopy.items[0].status, 'copied', JSON.stringify(peerCopy.items))
  const peerBytes = await readFile(join(peer.documents, peerCopy.items[0].target.docId), 'utf8')
  assert.equal(peerBytes, 'shared copy bytes')
  const completedManifest = async (instance, docId) => {
    for (const name of await readdir(join(instance.documents, '.upload-sessions', 'v1'))) {
      if (!/^[0-9a-f-]{36}$/u.test(name)) continue
      const manifest = JSON.parse(await readFile(join(instance.documents, '.upload-sessions', 'v1', name, 'manifest.json'), 'utf8'))
      if (manifest.ref?.docId === docId) return manifest
    }
    throw new Error('Copied document must retain its completed upload manifest')
  }
  const peerManifest = await completedManifest(peer, peerCopy.items[0].target.docId)
  const projectManifest = await completedManifest(target, copied.items[0].target.docId)
  assert.equal(peerManifest.formatVersion, 2)
  assert.equal(peerManifest.ownerId, 'user:9')
  assert.equal(projectManifest.ownerId, 'user:7')
  const foreignRead = await signedFetch(source, peerIdentity, `/api/documents/content?id=${encodeURIComponent(ref.docId)}`, undefined, other)
  assert.equal(foreignRead.status, 401)
  await foreignRead.text()
  const ownRead = await signedFetch(peer, peerIdentity, `/api/documents/content?id=${encodeURIComponent(peerCopy.items[0].target.docId)}`, undefined, other)
  assert.equal(ownRead.status, 200)
  assert.equal(await ownRead.text(), 'shared copy bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'readonly-member-personal-copy', status: peerCopy.items[0].status,
    bytes: peerBytes, personalOwner: peerManifest.ownerId, projectOwner: projectManifest.ownerId,
    ownPersonalRead: ownRead.status, foreignPersonalRead: foreignRead.status })}\n`)

  const restrictedResults = []
  const uploadSessionsBefore = await readdir(join(source.documents, '.upload-sessions', 'v1'))
  for (const purpose of ['archive-read', 'document-admin']) {
    const refused = await signedFetch(source, personalIdentity, '/api/documents/uploads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name: 'restricted.txt', directory: '', bytes: 1, fingerprint: purpose }),
    }, { ...user, role: 'admin' }, purpose)
    assert.equal(refused.status, 401)
    await refused.text()
    restrictedResults.push({ purpose, upload: refused.status })
  }
  assert.deepEqual(await readdir(join(source.documents, '.upload-sessions', 'v1')), uploadSessionsBefore)
  assert.equal(await readFile(join(source.documents, ref.docId), 'utf8'), 'shared copy bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'restricted-principal-upload', results: restrictedResults,
    newSessions: 0, originalBytes: 'shared copy bytes' })}\n`)
  const additionalIdentity = { kind: 'user', id: user.id, generation: 2, runtimeId: '76c5b3ae-f5ca-4134-ae05-93b1ed362f32' }
  const additional = await runtime('personal-additional', additionalIdentity, false, source.documents)
  allocatedRuntimes.set(additionalIdentity.runtimeId, additional)
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  const exactCopy = await transfer({ ...input, payload: { version: 1, source: { kind: 'project', projectId: 41 },
    target: { kind: 'personal', runtimeId: additionalIdentity.runtimeId }, documents: [{ docId: copied.items[0].target.docId }] } })
  assert.equal(exactCopy.items[0].status, 'copied', JSON.stringify(exactCopy.items))
  const exactPath = `/api/documents/content?id=${encodeURIComponent(exactCopy.items[0].target.docId)}`
  const exactRead = await signedFetch(additional, additionalIdentity, exactPath)
  assert.equal(exactRead.status, 200); assert.equal(await exactRead.text(), 'shared copy bytes')
  const mismatchedRuntime = await signedFetch(additional, personalIdentity, exactPath)
  assert.equal(mismatchedRuntime.status, 401); await mismatchedRuntime.text()
  const sharedRead = await signedFetch(source, personalIdentity, exactPath)
  assert.equal(sharedRead.status, 200); assert.equal(await sharedRead.text(), 'shared copy bytes')
  const additionalPrincipal = signer.verify(signer.issue({ user, scope: { kind: 'personal' }, runtime: additionalIdentity }))
  const additionalSubject = { ...subject, target: { kind: 'user', id: user.id, runtimeId: additionalIdentity.runtimeId }, generation: 2 }
  const selectedPayload = { version: 1, source: { kind: 'project', projectId: 41 }, target: { kind: 'personal' },
    documents: [{ docId: copied.items[0].target.docId }] }
  const selectedPlan = await plan({ subject: additionalSubject, principal: additionalPrincipal, payload: selectedPayload, signal: new AbortController().signal })
  const selectedCommit = { ...input, payload: { ...selectedPayload, planId: selectedPlan.planId } }
  await assert.rejects(commit(selectedCommit), { code: 'DOCUMENT_TRANSFER_PLAN_MISMATCH', status: 409 })
  const inferred = await commit({ ...selectedCommit, subject: additionalSubject, principal: additionalPrincipal })
  assert.equal(inferred.items[0].status, 'copied', JSON.stringify(inferred.items))
  process.stdout.write(`${JSON.stringify({ operation: 'personal-runtime-selection', copied: true, exactRuntime: exactRead.status,
    mismatchedRuntime: mismatchedRuntime.status, sharedDocuments: sharedRead.status, planRuntimeMismatch: 409 })}\n`)

  const httpEntry = runtime => [...runtime.ctx.loader.entries()].find(entry =>
    entry.options.name.includes('/host/userdoc-http/') || entry.options.name.endsWith('/unowned-http.mjs'))
  catalogGate = { entered: Promise.withResolvers(), release: Promise.withResolvers(), delivered: false }
  try {
    const identity = { kind: 'user', id: 7, generation: 1 }
    const listed = await signedFetch(source, identity, '/api/documents')
    assert.equal(listed.status, 200)
    await listed.json()
    await catalogGate.entered.promise
    let committedWhenStopped
    const stopping = httpEntry(source).fiber.dispose().then(() => { committedWhenStopped = catalogGate.delivered })
    consumerStops.push(stopping)
    const removed = await signedFetch(source, identity, '/api/documents')
    assert.equal(removed.status, 404)
    await removed.text()
    assert.equal(committedWhenStopped, undefined, 'catalog delivery must finish before HTTP unload')
    catalogGate.release.resolve()
    await stopping
    assert.equal(committedWhenStopped, true)
    process.stdout.write(`${JSON.stringify({ operation: 'document-catalog-unload', listed: listed.status,
      routeRemoved: removed.status, committedWhenStopped, actor: catalogGate.actor })}\n`)
  } finally {
    catalogGate.release.resolve()
  }

  const identity = { kind: 'project', id: 41, generation: 1 }
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const store = target.ctx.userDocs, originalList = store.list
  store.list = async signal => { entered.resolve(); await release.promise; return originalList.call(store, signal) }
  const pending = signedFetch(target, identity, '/api/documents')
  try {
    await entered.promise
    let stopped = false
    const stopping = httpEntry(target).fiber.dispose().then(() => { stopped = true })
    consumerStops.push(stopping)
    const removed = await signedFetch(target, identity, '/api/documents')
    assert.equal(removed.status, 404)
    await removed.text()
    assert.equal(stopped, false, 'accepted document read must finish before HTTP unload')
    release.resolve()
    const listed = await pending
    assert.equal(listed.status, 200)
    const names = (await listed.json()).documents.map(row => row.name)
    assert.deepEqual(names, ['report.txt'])
    await stopping
    process.stdout.write(`${JSON.stringify({ operation: 'document-read-unload', listed: listed.status,
      routeRemoved: removed.status, documents: names })}\n`)
  } finally {
    release.resolve()
    store.list = originalList
    await pending
  }

  const missing = await runtime('project-without-collaboration', identity, false)
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  const refused = await signedFetch(missing, identity, '/api/documents/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, name: 'unowned.txt', directory: '', bytes: 1, fingerprint: 'unowned' }),
  })
  assert.equal(refused.status, 503)
  const error = await refused.json()
  assert.equal(error.error.code, 'COLLABORATION_UNAVAILABLE')
  assert.equal(error.error.message, 'Document authorization is temporarily unavailable.')
  const entries = await readdir(join(missing.documents, '.upload-sessions', 'v1')).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const sessions = entries.filter(name => /^[0-9a-f-]{36}$/u.test(name))
  assert.deepEqual(sessions, [])
  process.stdout.write(`${JSON.stringify({ operation: 'project-upload-no-authority', status: refused.status,
    error: error.error.code, message: error.error.message, createdSessions: sessions.length })}\n`)
} finally {
  Date.now = realNow
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  catalogGate?.release.resolve()
  const stoppedConsumers = await Promise.allSettled(consumerStops)
  const results = await Promise.allSettled(contexts.reverse().map(ctx => ctx.fiber.dispose()))
  await Promise.all([...metadataTasks])
  metadata.closeAllConnections()
  if (metadata.listening) await new Promise((resolve, reject) => metadata.close(error => error ? reject(error) : resolve()))
  const failures = [...metadataFailures, ...[...stoppedConsumers, ...results].filter(result => result.status === 'rejected').map(result => result.reason)]
  if (failures.length > 0) throw new AggregateError(failures, 'Document transfer fixture disposal failed')
}
