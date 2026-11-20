/** Built browser Session admission through two Gateways and one controlled model. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { PreparedSessionApi } from '../../../packages/client/runtime/lib/types/client/prepare-runtime.js'
import { Session } from '../../../packages/client/runtime/lib/types/client/sessions/session.js'

/** @param options - exact fixture allocation and the owner of the outbound agent. */
export async function verifyQueuedPromptReconnect({ pool, base, cookie, runtimeId, nodeId, userId, disconnect, reconnect }) {
  const target = { kind: 'personal', runtimeId, nodeId }
  const calls = []
  const refused = Promise.withResolvers()
  class GatewayApi extends PreparedSessionApi {
    constructor(location) { super({ interactions: 'none', metadataTiming: { requestTimeoutMs: 20000, retryAfterMs: 100 } }, location, userId) }
    resolveBase() { return base }
    async doFetch(url, init) {
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      headers.set('origin', base)
      const response = await super.doFetch(url, { ...init, headers })
      if (url.pathname.startsWith('/api/admit/v1/')) {
        const payload = JSON.parse(init.body).payload
        assert.equal(url.searchParams.get('dshRuntime'), runtimeId)
        assert.equal(url.searchParams.get('dshNode'), nodeId)
        calls.push({ path: url.pathname, payload, status: response.status })
        if (calls.length === 1) refused.resolve(response.status)
      }
      return response
    }
  }
  const sessionId = 'session-' + randomUUID()
  const created = await new GatewayApi(target).sessions.create({ sessionId, draftId: 'draft-' + randomUUID(), defaultWorkspace: true })
  assert.equal(created.result.ok, true)
  const described = await fetch(`${base}/api/host.describe?dshRuntime=${runtimeId}&dshTarget=personal`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'host.describe', payload: {} }),
  })
  assert.equal(described.status, 200)
  const description = (await described.json()).result
  assert.equal(description.ok, true)
  assert.deepEqual(description.value.runtimeTarget, target)
  const api = new GatewayApi(description.value.runtimeTarget)
  const selection = await fetch(`${base}/api/session.selectModel?dshRuntime=${runtimeId}&dshNode=${nodeId}&dshTarget=personal`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.selectModel',
      payload: { sessionId, provider: 'org-topology', model: 'fixture-chat' } }),
  })
  assert.equal((await selection.json()).result?.ok, true)
  const ownership = async () => (await pool.query(`SELECT i.generation, i.node_connection_epoch, a.connection_epoch
    FROM harness.instances i JOIN harness.node_agents a
      ON a.organization_id=i.organization_id AND a.node_id=i.assigned_node_id
    WHERE i.runtime_id=$1 AND a.node_id=$2`, [runtimeId, nodeId])).rows[0]
  const original = await ownership()
  const slots = new Map()
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => slots.get(key) ?? null, setItem: (key, value) => slots.set(key, value), removeItem: key => slots.delete(key),
  } })
  const client = new Session(sessionId, api, {}, { admission: () => api })
  const text = 'One queued message across a node lease change.'
  const echo = client.beginSubmission({ text, mode: 'queue', images: [] })
  const transcript = ['Direct Runtime entry discovers the owning computer before the first send.']
  let submission
  try {
    await disconnect()
    submission = client.prompt([{ type: 'text', text }], 'queue', AbortSignal.timeout(90000), echo.requestId)
    const first = await Promise.race([refused.promise, submission.then(() => undefined)])
    assert.equal(first, 503)
    assert.equal(client.getSnapshot().pendingSubmissions[0]?.text, text)
    transcript.push('While the computer is offline the original queued input stays visible and unconfirmed.')
    await reconnect()
    assert.deepEqual(await submission, { ok: true, value: { accepted: true } })
    const current = await ownership()
    assert.ok(BigInt(current.generation) > BigInt(original.generation))
    assert.ok(BigInt(current.connection_epoch) > BigInt(original.connection_epoch))
    assert.equal(current.node_connection_epoch, current.connection_epoch)
    assert.equal(slots.size, 0)
    const sends = calls.filter(call => call.path.endsWith('/session.prompt'))
    assert.equal(sends.length, 2)
    assert.deepEqual(sends[0].payload, sends[1].payload)
    assert.ok(calls.slice(1, -1).some(call => call.path.endsWith('/session.status') && call.status === 200))
    transcript.push('After the node lease changes, the same browser submission reads its receipt and resumes in the new Runtime generation.')
    const signal = AbortSignal.timeout(16000)
    for (;;) {
      const result = (await api.sessions.history({ sessionId, detail: 'conversation' }, signal)).result
      assert.equal(result.ok, true)
      const records = result.value.events
      const completed = records.find(record => record.event.type === 'turn/end')
      if (completed !== undefined) {
        const admissions = records.filter(record => record.event.type === 'agent/inbox/spliced'
          && record.event.data.inserted?.some(message => message.role === 'user' && message.source?.rpcId === echo.requestId))
        assert.equal(admissions.length, 1)
        assert.equal(completed.event.data.reason.kind, 'completed')
        assert.match(JSON.stringify(records), /controlled-node-response/u)
        break
      }
      await delay(100, undefined, { signal })
    }
    transcript.push('The owning Runtime records one user input and a complete model reply.')
    assert.equal(transcript.join('\n') + '\n', await readFile(new URL('../expected/queued-prompt-reconnect.txt', import.meta.url), 'utf8'))
    console.log(JSON.stringify({ scope: 'queued-prompt-reconnect', leaseChanged: true, durableInputs: 1, completeReply: true }))
  } finally {
    client.dispose()
    await submission?.catch(() => {})
    if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage)
    else delete globalThis.sessionStorage
  }
}
