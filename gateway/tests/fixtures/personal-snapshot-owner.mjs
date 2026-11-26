/** Test-only scoped provider: sealed synthetic domains, independent validation, and no live Runtime or timer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [action, requestPath, payload] = process.argv.slice(2)
assert.ok(action === 'capture' || action === 'validate')
const config = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'provider.json'), 'utf8'))
const request = JSON.parse(await readFile(requestPath, 'utf8'))
assert.equal(request.kind, 'personal')
const path = join(payload, 'personal-provider.json')
if (action === 'capture') await copyFile(config.source, path)
const bytes = await readFile(path)
assert.ok(bytes.length <= request.limits.maxBytes)
const state = JSON.parse(bytes.toString('utf8'))
const checksum = createHash('sha256').update(bytes).digest('hex')
const digestPath = join(payload, 'personal-provider.sha256')
if (action === 'capture') await writeFile(digestPath, checksum, { flag: 'wx', mode: 0o600 })
else assert.equal(await readFile(digestPath, 'utf8'), checksum)
const gaps = state.domains.plugins.unverified.length ? ['plugins:unverified-managed-paths'] : []
const capture = { version: 1, organizationId: state.organizationId, sourceNodeId: state.sourceNodeId,
  scopeId: state.scopeId, writerEpoch: state.writerEpoch, watermark: state.watermark, capturedAt: state.capturedAt,
  coveredCount: Object.keys(state.domains).length, gaps }
if (action === 'capture') process.stdout.write(JSON.stringify(capture))
else {
  assert.deepEqual(request.capture, capture)
  for (const key of ['organizationId', 'sourceNodeId', 'scopeId']) assert.equal(state[key], request[key])
  assert.equal(state.domains.sessions.generation, 'session.v1.jsonl')
  for (const receipt of state.domains['background-delivery'].receipts) {
    assert.ok(state.domains.sessions.inbox.some(message => message.sessionId === receipt.sessionId && message.id === receipt.messageId))
  }
  for (const reference of state.domains['document-references']) {
    assert.equal(createHash('sha256').update(state.domains.files[reference.name]).digest('hex'), reference.sha256)
  }
  assert.deepEqual(state.domains.drafts.map(draft => draft.tab), ['tab-a', 'tab-b'])
  const checked = request.requiredDomains.filter(domain => domain in state.domains && domain !== config.omitCheck
    && !(domain === 'plugins' && gaps.length))
  process.stdout.write(JSON.stringify({ version: 1, checked }))
}
