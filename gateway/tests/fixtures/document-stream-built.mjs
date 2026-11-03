/** Plain Node loads the compiled document receiver and validates a signed request through its public wire package. */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createRuntimeApiHandler } from '../../lib/runtime-api.js'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../../lib/principal.js'
import { documentRequestSchema, GATEWAY_DOCUMENT_STORE_PATH } from '@deepseek-ai/dsh-userdoc-gateway/protocol'

const { privateKey } = generateKeyPairSync('ed25519')
const signer = new GatewayPrincipalSigner(privateKey, 'compiled-documents', 60_000)
const runtimeId = '00000000-0000-4000-8000-000000000007'
const nodeId = '00000000-0000-4000-8000-000000000009'
const subject = { organizationId: 'compiled-documents', target: { kind: 'user', id: 7, runtimeId }, generation: 1 }
const principal = signer.issue({ user: { id: 7, username: 'member-7', displayName: 'Member 7', role: 'user' },
  scope: { kind: 'personal' }, runtime: { kind: 'user', id: 7, runtimeId, generation: 1 } })
const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'request' }, operation: { kind: 'list' } })
let resolved, status, body
const listeners = new Set()
let computerGranted = true
const pool = { async query(sql, values) {
  assert.match(sql, /harness\.computer_use_allowed/u)
  assert.deepEqual(values, [subject.organizationId, 7, nodeId])
  return { rows: computerGranted ? [{}] : [], rowCount: computerGranted ? 1 : 0 }
} }
const handler = createRuntimeApiHandler({ context: { pool, organizationSlug: 'compiled-documents', nodeId },
  accessMonitor: { available: true, async synchronize() {}, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) } },
  instances: { async authenticateRuntimeToken(token) { return token === 'fixture-runtime' ? subject : null } },
  principals: signer, conversations: {}, collaboration: {}, governance: {},
  async documentStore(invocation) {
    resolved = await invocation.authorize(envelope, new AbortController().signal)
    invocation.response.writeHead(200); invocation.response.end(JSON.stringify({ actor: resolved.principal.user.id }))
  },
})
const request = { method: 'POST', url: GATEWAY_DOCUMENT_STORE_PATH,
  headers: { authorization: 'Bearer fixture-runtime', [PRINCIPAL_HEADER]: principal }, resume() {} }
const response = { writeHead(value) { status = value; return this }, end(value) { body = value; return this } }
assert.equal(await handler.stream(request, response, GATEWAY_DOCUMENT_STORE_PATH, async () => 'open'), true)
assert.equal(status, 200); assert.equal(resolved.kind, 'request')
assert.deepEqual(JSON.parse(body), { actor: 7 })
assert.equal(listeners.size, 0)
computerGranted = false
status = undefined
await assert.rejects(handler.stream(request, response, GATEWAY_DOCUMENT_STORE_PATH, async () => 'open'),
  error => error.code === 'DOCUMENT_PERMISSION_DENIED')
assert.equal(status, undefined)
assert.equal(listeners.size, 0)
assert.equal(await handler.stream(request, response, '/internal/runtime/another-endpoint', async () => 'open'), false)
console.log(JSON.stringify({ operation: 'compiled-document-authority', actor: 7, revokedComputer: 'denied', unrelatedRoute: 'untouched' }))
