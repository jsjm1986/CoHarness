/** Real HTTP replay of the emitted browser uploader and an accepted verification past its receiving deadline. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readManagedDataPaths } from '@deepseek-ai/dsh-managed-data'
import { loadConfig } from '../../lib/config.js'
import { LocalDocumentBroker } from '../../lib/documents-local.js'
import { DOCUMENT_TRANSFER_UPLOADS_PATH, DocumentTransferError } from '../../lib/document-transfer.js'
import { GatewayPrincipalSigner } from '../../lib/principal.js'

const browserPackages = createRequire(new URL('../../../packages/client/userdoc-upload/package.json', import.meta.url))
const { resumableUpload } = await import(pathToFileURL(browserPackages.resolve('@deepseek-ai/dsh-client-userdoc-upload')).href)

function deferred() {
  let resolve
  const promise = new Promise(ready => { resolve = ready })
  return { promise, resolve }
}

const root = await mkdtemp(join(tmpdir(), 'hgw-expired-verification-'))
const lifetime = new AbortController(), release = deferred(), entered = deferred()
const deadline = setTimeout(() => lifetime.abort(new Error('Document verification replay deadline')), 60_000)
const browserStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let broker, server, failure, hold = false, writers = 0
async function wait(pending) {
  const signal = lifetime.signal
  signal.throwIfAborted()
  const aborted = Promise.withResolvers(), onAbort = () => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try { return await Promise.race([pending, aborted.promise]) }
  finally { signal.removeEventListener('abort', onAbort) }
}
try {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'),
    HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
    HGW_STATE_ROOT: join(root, 'state'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
  const user = { id: 7, username: 'member', displayName: 'Member', role: 'user', status: 'active',
    homePath: join(root, 'home'), mustChangePassword: false, autoReviewEligible: false }
  await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
  await mkdir(user.homePath, { recursive: true, mode: 0o700 })
  let cursor = { sequence: 0, ordinal: 0 }
  const retain = async operation => {
    writers += 1
    try {
      if (hold && writers > 1) {
        hold = false
        entered.resolve()
        await wait(release.promise)
      }
      await operation()
    } finally { writers -= 1 }
  }
  broker = new LocalDocumentBroker({ cfg, organizationId: 'accepted-verification',
    users: { async getById(id) { return id === user.id ? user : null } }, projects: {}, collaboration: {},
    instances: { async generationOf() { return 1 } },
    principals: new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'accepted-verification', 60_000),
    catalog: { async projection({ payload }) { cursor = payload.batch?.next ?? cursor; return { version: 1, cursor } } },
    writes: { retain, admit: retain },
  })
  const failures = []
  server = createServer((request, response) => {
    void broker.serveUpload({ user, request, pathname: new URL(request.url, 'http://fixture').pathname,
      scope: { kind: 'personal' }, signal: lifetime.signal,
    }).then(async result => {
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text())
    }).catch(error => {
      if (error instanceof DocumentTransferError) {
        response.writeHead(error.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: error.code, message: error.message } }))
      } else { failures.push(error); response.destroy(error) }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const base = `http://127.0.0.1:${server.address().port}`, seed = new AbortController(), sessions = new Set()
  let seeding = true, uploadId, polled = false
  const options = { root: '/api/documents/transfer',
    async requestJson(path, init) {
      if (init?.method !== 'POST') { polled = true; hold = false; release.resolve() }
      const signal = init?.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, init.signal])
      const response = await fetch(base + path, { ...init, signal }), value = await response.json()
      if (!response.ok) throw Object.assign(new Error(value.error?.message ?? 'Document HTTP request failed'), { status: response.status })
      if (path === DOCUMENT_TRANSFER_UPLOADS_PATH && init?.method === 'POST') {
        sessions.add(value.uploadId); uploadId = value.uploadId
        if (seeding) { seeding = false; seed.abort() }
      }
      return value
    },
    networkError: () => new Error('The empty-file replay must not send an XHR chunk.'),
    responseError: status => new Error(`Document upload response refused: ${status}`),
  }
  const file = new File([], 'accepted.txt')
  await assert.rejects(resumableUpload(file, '', seed.signal, undefined, options), { name: 'AbortError' })
  assert.equal(typeof uploadId, 'string')
  hold = true
  const accepted = await fetch(`${base}${DOCUMENT_TRANSFER_UPLOADS_PATH}/${uploadId}/complete`, { method: 'POST',
    signal: lifetime.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, sha256: createHash('sha256').digest('hex') }) })
  assert.equal(accepted.status, 202); await accepted.arrayBuffer()
  await wait(entered.promise)
  const files = readManagedDataPaths(join(cfg.stateRoot, 'document-identity-roots.jsonl')).find(row => row.owner.endsWith('/files'))
  assert(files !== undefined)
  const path = join(files.path, '.upload-sessions', 'v1', uploadId, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...manifest, expiresAt: 1 }) + '\n')
  const result = await resumableUpload(file, '', lifetime.signal, undefined, options)
  assert.equal(result.docId, 'accepted.txt'); assert.equal(result.bytes, 0)
  assert.equal(polled, true); assert.equal(sessions.size, 1)
  assert.equal(await readFile(join(user.homePath, 'documents', 'accepted.txt'), 'utf8'), '')
  await broker.dispose()
  assert.equal(writers, 0); assert.deepEqual(failures, [])
  const output = JSON.stringify({ case: 'browser-expired-verification', sameUpload: true, state: 'complete', polled, publicBytes: result.bytes, writers }) + '\n'
  assert.equal(output, await readFile(new URL('../expected/document-upload-expiry-client.jsonl', import.meta.url), 'utf8'))
  process.stdout.write(output)
} catch (error) { failure = error; throw error }
finally {
  clearTimeout(deadline); hold = false; release.resolve(); lifetime.abort()
  server?.closeAllConnections()
  const settled = await Promise.allSettled([
    ...(broker === undefined ? [] : [broker.dispose()]),
    ...(server === undefined || !server.listening ? [] : [new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })]),
  ])
  if (browserStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
  else Object.defineProperty(globalThis, 'localStorage', browserStorage)
  const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
  if (errors.length > 0) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'Document verification replay cleanup failed')
}
