/** Managed directory capture through the actual Gateway broker, HTTP routes and SQLite/filesystem provider. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs, { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { withDirectoryRenameInterleave } from '../../../packages/attachment/userdoc-local/tests/fixtures/directory-native-interleave.mjs'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Directory capture replay requires src or lib.')
const entry = mode === 'src' ? 'src' : 'lib', extension = mode === 'src' ? 'ts' : 'js'
const { LocalDocumentBroker } = await import(new URL(`../../${entry}/documents-local.${extension}`, import.meta.url))
const { loadConfig } = await import(new URL(`../../${entry}/config.${extension}`, import.meta.url))
const { GatewayPrincipalSigner } = await import(new URL(`../../${entry}/principal.${extension}`, import.meta.url))
const { DocumentTransferError, DOCUMENT_TRANSFER_UPLOADS_PATH } = await import(new URL(`../../${entry}/document-transfer.${extension}`, import.meta.url))
const { DocumentCatalogError } = await import(new URL(`../../${entry}/document-catalog.${extension}`, import.meta.url))
const root = process.cwd(), project = join(root, 'projects', 'shared'), documents = join(project, 'documents')
const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'),
  HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
  HGW_STATE_ROOT: join(root, 'state'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
  HGW_PROJECT_RUNTIME_USER: 'nobody' })
await mkdir(project, { recursive: true }); await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
const users = [7, 9].map(id => ({ id, username: `member-${id}`, displayName: `Member ${id}`, role: 'user',
  status: 'active', homePath: join(root, `home-${id}`), mustChangePassword: false, autoReviewEligible: false }))
const records = new Map(), cursors = new Map(), failures = []
const { privateKey } = generateKeyPairSync('ed25519')
const dependencies = {
  cfg, organizationId: 'directory-capture-replay',
  principals: new GatewayPrincipalSigner(privateKey, 'directory-capture-replay', 60_000),
  users: { async getById(id) { return users.find(user => user.id === id) ?? null } },
  projects: { async getById(id) { return id === 41 ? { id, name: 'Shared', path: project, members: [], memberCount: 2, origin: 'admin' } : null } },
  instances: { async generationOf() { return 1 } },
  collaboration: { async projectForUser(id, actor) {
    return id === 41 && users.some(user => user.id === actor)
      ? { projectId: id, name: 'Shared', path: project, mode: 'rw', administrator: false } : null
  } },
  // The external catalog service is stateful; file mutation, authorization transport and projection delivery are real.
  catalog: {
    async projectionOwner() { return null },
    async projection({ payload }) {
      if (payload.batch !== undefined) {
        for (const change of payload.batch.changes) records.set(change.document.incarnationId, change.document)
        cursors.set(payload.rootId, payload.batch.next)
      }
      return { version: 1, cursor: cursors.get(payload.rootId) ?? { sequence: 0, ordinal: 0 } }
    },
    async sync() { return { version: 1, accepted: 0 } },
    async authorize({ principal, payload }) {
      const selected = payload.documents.map(candidate => [...records.values()].find(record =>
        record.state === 'active' && record.docId === candidate.docId))
      if (selected.some(record => record === undefined || record.createdBy !== `user:${principal.user.id}`)) {
        throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'Only the document owner can modify this document.')
      }
      return { version: 1, allowed: true, selections: selected.map(record => ({ docId: record.docId,
        incarnationId: record.incarnationId, revision: record.revision, state: record.state })) }
    },
  },
}
let broker = new LocalDocumentBroker(dependencies)
const signal = AbortSignal.timeout(20_000)
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, 'http://fixture'), user = users.find(row => String(row.id) === request.headers['x-fixture-user'])
    assert(user !== undefined)
    const input = { user, request, scope: { kind: 'project', projectId: 41 }, signal }
    const result = url.pathname.startsWith(DOCUMENT_TRANSFER_UPLOADS_PATH)
      ? await broker.serveUpload({ ...input, pathname: url.pathname })
      : await broker.serveScope({ ...input, operation: url.pathname.endsWith('/folders') ? 'folders' : 'list' })
    assert(result instanceof Response)
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text())
  })().catch(error => {
    if (error instanceof DocumentTransferError) {
      response.writeHead(error.status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.code }))
    } else { failures.push(error); response.destroy(error) }
  })
})
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, init, actor = 7) => fetch(base + path, { ...init,
    headers: { ...init?.headers, 'x-fixture-user': String(actor) }, signal })
  const folder = await call('/api/documents/folders?directory=&name=selected', { method: 'POST' })
  assert.equal(folder.status, 201); await folder.arrayBuffer()
  const upload = async (directory, name, bytes, actor = 7) => {
    const digest = createHash('sha256').update(bytes).digest('hex')
    const started = await call(DOCUMENT_TRANSFER_UPLOADS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, directory, name, bytes: bytes.length, fingerprint: `${directory}/${name}` }) }, actor)
    const startedBody = await started.json()
    assert.equal(started.status, 200, JSON.stringify(startedBody))
    const { uploadId } = startedBody, uploadPath = `${DOCUMENT_TRANSFER_UPLOADS_PATH}/${uploadId}`
    const chunk = await call(`${uploadPath}/chunks/0`, { method: 'PUT', body: bytes, headers: {
      'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'x-dsh-chunk-sha256': digest } }, actor)
    assert.equal(chunk.status, 200); await chunk.arrayBuffer()
    const accepted = await call(`${uploadPath}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, sha256: digest }) }, actor)
    assert.equal(accepted.status, 202); await accepted.arrayBuffer()
    for (;;) {
      const inspected = await call(uploadPath, undefined, actor), state = await inspected.json()
      assert([200, 202].includes(inspected.status))
      if (state.state === 'complete') return state.ref
      assert.equal(state.state, 'verifying')
    }
  }
  const bytes = Buffer.from('original actor bytes'), original = await upload('selected', 'a.txt', bytes)
  assert.equal(original.identity.createdBy, 'user:7')
  const source = join(documents, 'selected'), held = join(documents, 'held-original'), target = join(documents, 'renamed')
  let swapped = false
  await withDirectoryRenameInterleave(async from => {
    if (!swapped && basename(from) === 'selected') {
      await rename(source, held); await mkdir(source); await writeFile(join(source, 'foreign.txt'), 'foreign bytes')
      swapped = true
    }
  }, async () => {
    const refused = await call('/api/documents/folders?id=selected&name=renamed', { method: 'PATCH' })
    assert.equal(refused.status, 409); await refused.arrayBuffer()
  })
  assert.equal(swapped, true)
  assert.equal(await readFile(join(source, 'foreign.txt'), 'utf8'), 'foreign bytes')
  assert.equal(await readFile(join(held, 'a.txt'), 'utf8'), bytes.toString())
  await assert.rejects(stat(target), { code: 'ENOENT' })
  process.stdout.write(`${JSON.stringify({ operation: 'source-substitution', status: 409, foreignSourcePreserved: true, targetAbsent: true })}\n`)
  await rename(source, join(documents, 'unrelated')); await rename(held, source)
  await broker.dispose(); broker = new LocalDocumentBroker(dependencies)
  const listed = await call('/api/documents/scope'), listing = await listed.json()
  assert.equal(listed.status, 200)
  assert.equal(listing.documents.some(file => file.name.startsWith('.dsh-directory-')), false)
  assert.deepEqual(await readdir(source), ['a.txt'])
  process.stdout.write(`${JSON.stringify({ operation: 'restart', controlDocumentImported: false, originalCreator: 'user:7' })}\n`)
  const denied = await call('/api/documents/folders?id=selected&name=stolen', { method: 'PATCH' }, 9)
  assert.equal(denied.status, 403); await denied.arrayBuffer()
  assert.equal(await readFile(join(source, 'a.txt'), 'utf8'), bytes.toString())
  process.stdout.write(`${JSON.stringify({ operation: 'other-account', status: 403, sourcePreserved: true })}\n`)
  const retry = await call('/api/documents/folders?id=selected&name=renamed', { method: 'PATCH' })
  assert.equal(retry.status, 200); await retry.arrayBuffer()
  const moved = [...records.values()].find(record => record.state === 'active' && record.docId === 'renamed/a.txt')
  assert.equal(moved.incarnationId, original.identity.incarnationId); assert.equal(moved.createdBy, 'user:7')
  assert.equal(await readFile(join(documents, 'unrelated', 'foreign.txt'), 'utf8'), 'foreign bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'fresh-retry', status: 200, identityPreserved: true, creatorPreserved: true, foreignBytesPreserved: true })}\n`)
  const editedFolder = join(documents, 'edited'), originalLstat = fs.lstat
  let edited = false
  fs.lstat = async (...args) => {
    const info = await originalLstat(...args)
    if (!edited && String(args[0]) === editedFolder && info.isDirectory()) {
      edited = true
      await writeFile(join(documents, 'editor.part'), 'late HTTP editor bytes')
      await rename(join(documents, 'editor.part'), join(editedFolder, 'a.txt'))
    }
    return info
  }
  syncBuiltinESMExports()
  try {
    const result = await call('/api/documents/folders?id=renamed&name=edited', { method: 'PATCH' })
    assert.equal(result.status, 200); await result.arrayBuffer()
  } finally { fs.lstat = originalLstat; syncBuiltinESMExports() }
  assert.equal(edited, true)
  assert.equal(await readFile(join(editedFolder, 'a.txt'), 'utf8'), 'late HTTP editor bytes')
  const replacement = [...records.values()].find(record => record.state === 'active' && record.docId === 'edited/a.txt')
  assert(replacement !== undefined); assert.notEqual(replacement.incarnationId, original.identity.incarnationId)
  assert.equal(replacement.createdBy, undefined)
  assert.equal(records.get(original.identity.incarnationId).state, 'missing')
  assert.equal(records.get(original.identity.incarnationId).createdBy, 'user:7')
  process.stdout.write(`${JSON.stringify({ operation: 'late-editor-save', status: 200, editedBytesPreserved: true,
    previousIdentityRetired: true, replacementCreatorUnknown: true })}\n`)
  for (const name of ['first', 'second']) {
    const created = await call(`/api/documents/folders?directory=&name=${name}`, { method: 'POST' })
    assert.equal(created.status, 201); await created.arrayBuffer()
  }
  const first = await upload('first', 'a.txt', Buffer.from('first member bytes'))
  const second = await upload('second', 'a.txt', Buffer.from('second member bytes'), 9)
  await rename(join(documents, 'first', 'a.txt'), join(documents, 'exchange.part'))
  await rename(join(documents, 'second', 'a.txt'), join(documents, 'first', 'a.txt'))
  await rename(join(documents, 'exchange.part'), join(documents, 'second', 'a.txt'))
  await broker.dispose(); broker = new LocalDocumentBroker(dependencies)
  const exchanged = await call('/api/documents/scope?directory=first')
  assert.equal(exchanged.status, 200); await exchanged.arrayBuffer()
  await broker.dispose(); broker = new LocalDocumentBroker(dependencies)
  assert.equal(records.get(first.identity.incarnationId).docId, 'second/a.txt')
  assert.equal(records.get(first.identity.incarnationId).createdBy, 'user:7')
  assert.equal(records.get(second.identity.incarnationId).docId, 'first/a.txt')
  assert.equal(records.get(second.identity.incarnationId).createdBy, 'user:9')
  const otherActor = await call('/api/documents/folders?id=first&name=not-yours', { method: 'PATCH' })
  assert.equal(otherActor.status, 403); await otherActor.arrayBuffer()
  const correctActor = await call('/api/documents/folders?id=first&name=owner-renamed', { method: 'PATCH' }, 9)
  assert.equal(correctActor.status, 200); await correctActor.arrayBuffer()
  assert.equal(await readFile(join(documents, 'owner-renamed', 'a.txt'), 'utf8'), 'second member bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'external-address-exchange', identitiesPreserved: true,
    creatorsPreserved: true, otherAccountStatus: 403, ownerRenameStatus: 200 })}\n`)
  await rename(join(documents, 'second', 'a.txt'), join(documents, 'second', 'moved.txt'))
  await writeFile(join(documents, 'second', 'a.txt'), 'external replacement bytes')
  const reused = await call('/api/documents/scope?directory=second')
  assert.equal(reused.status, 200); await reused.arrayBuffer()
  await broker.dispose(); broker = new LocalDocumentBroker(dependencies)
  const movedOriginal = records.get(first.identity.incarnationId)
  assert.equal(movedOriginal.docId, 'second/moved.txt'); assert.equal(movedOriginal.createdBy, 'user:7')
  const reusedReplacement = [...records.values()].find(record => record.state === 'active' && record.docId === 'second/a.txt')
  assert(reusedReplacement !== undefined); assert.notEqual(reusedReplacement.incarnationId, first.identity.incarnationId)
  assert.equal(reusedReplacement.createdBy, undefined)
  assert.equal(await readFile(join(documents, 'second', 'moved.txt'), 'utf8'), 'first member bytes')
  assert.equal(await readFile(join(documents, 'second', 'a.txt'), 'utf8'), 'external replacement bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'external-address-reuse', identityPreserved: true,
    creatorPreserved: true, replacementCreatorUnknown: true, bothContentsPreserved: true })}\n`)
  assert.deepEqual(failures, [])
} finally {
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  await broker.dispose()
}
