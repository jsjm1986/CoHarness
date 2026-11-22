/** Built browser Session admission through two Gateways and one controlled model. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { ApiTransportError } from '../../../packages/host/apiproxy/lib/types/fetch/client.js'
import { PreparedSessionApi } from '../../../packages/client/runtime/lib/types/client/prepare-runtime.js'
import { Session } from '../../../packages/client/runtime/lib/types/client/sessions/session.js'

/** @param options - exact fixture allocation and the owner of the outbound agent. */
export async function verifyQueuedPromptReconnect({ pool, base, cookie, runtimeId, nodeId, userId, projectId, disconnect, reconnect, revokeModel }) {
  const target = projectId === undefined ? { kind: 'personal', runtimeId, nodeId } : { kind: 'project', projectId, runtimeId, nodeId }
  const targetQuery = projectId === undefined ? 'personal' : `project:${projectId}`
  const query = new URLSearchParams({ dshRuntime: runtimeId, dshNode: nodeId, dshTarget: targetQuery })
  const calls = []
  const sessionId = 'session-' + randomUUID()
  const draftId = 'draft-' + randomUUID()
  const preferred = { provider: 'org-topology', model: projectId === undefined ? 'fixture-chat' : 'fixture-draft-chat' }
  const fallback = { provider: 'org-topology', model: 'fixture-chat' }
  const unmaterialized = async () => (await pool.query(`SELECT d.draft_id,d.visibility,d.model_selection,p.public_id::int project,u.public_id::int creator,
      NOT EXISTS (SELECT FROM harness.conversation_sessions c WHERE c.runtime_id=d.runtime_id AND c.id=d.session_id) AS unmaterialized
    FROM harness.conversation_draft_reservations d
    JOIN harness.projects p ON (p.organization_id,p.id)=(d.organization_id,d.project_id)
    JOIN harness.users u ON (u.organization_id,u.id)=(d.organization_id,d.user_id)
    WHERE d.runtime_id=$1 AND d.session_id=$2`, [runtimeId, sessionId])).rows[0]
  const expectedDraft = { draft_id: draftId, visibility: 'private', project: projectId, creator: userId, unmaterialized: true, model_selection: preferred }
  let checkedUnmaterializedReceipt = false
  let lostReply = false
  const refused = Promise.withResolvers()
  class GatewayApi extends PreparedSessionApi {
    constructor(location) { super({ interactions: 'none', metadataTiming: { requestTimeoutMs: 20000, retryAfterMs: 100 } }, location, userId) }
    resolveBase() { return base }
    async doFetch(url, init) {
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      headers.set('origin', base)
      const response = await super.doFetch(url, { ...init, headers })
      if (response.status === 500) throw new Error(`Fixture ${url.pathname}: ${await response.text()}`)
      if (url.pathname.startsWith('/api/admit/v1/')) {
        const payload = JSON.parse(init.body).payload
        assert.equal(url.searchParams.get('dshRuntime'), runtimeId)
        assert.equal(url.searchParams.get('dshNode'), nodeId)
        assert.equal(url.searchParams.get('dshTarget'), targetQuery)
        calls.push({ path: url.pathname, payload, status: response.status })
        if (calls.length === 1) refused.resolve(response.status)
        if (projectId !== undefined && !lostReply && url.pathname.endsWith('/session.status') && response.ok) {
          assert.deepEqual((await response.clone().json()).result, { ok: true, value: { state: 'unknown' } })
          assert.deepEqual(await unmaterialized(), expectedDraft)
          checkedUnmaterializedReceipt = true
        }
        if (projectId !== undefined && !lostReply && url.pathname.endsWith('/session.prompt') && response.ok) {
          const result = (await response.clone().json()).result
          if (result.ok) {
            assert.deepEqual(result.value, { accepted: true })
            await response.body?.cancel()
            lostReply = true
            throw new ApiTransportError(0, url.pathname)
          }
          assert.equal(result.error.code, 'model-forbidden')
        }
      }
      return response
    }
  }
  const created = await new GatewayApi(target).sessions.create({
    sessionId, draftId, defaultWorkspace: true, ...(projectId === undefined ? {} : { visibility: 'private' }),
  })
  assert.equal(created.result.ok, true, JSON.stringify(created.result))
  assert.equal(created.result.value.sessionId, sessionId)
  const described = await fetch(`${base}/api/host.describe?${query}`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'host.describe', payload: {} }),
  })
  assert.equal(described.status, 200)
  const description = (await described.json()).result
  assert.equal(description.ok, true)
  assert.deepEqual(description.value.runtimeTarget, target)
  const api = new GatewayApi(description.value.runtimeTarget)
  const rpc = async (method, payload) => {
    const reply = await fetch(`${base}/api/${method}?${query}`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { sessionId, ...payload } }),
    })
    assert.equal(reply.status, 200)
    return (await reply.json()).result
  }
  if (projectId !== undefined) {
    const initial = await rpc('session.models', {})
    assert.equal(initial.ok, true)
    assert.equal(initial.value.current.model, fallback.model)
  }
  assert.deepEqual(await rpc('session.selectModel', preferred), { ok: true, value: { selected: preferred } })
  if (projectId !== undefined) assert.deepEqual(await unmaterialized(), expectedDraft)
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
  let rejectedText
  let echo = client.beginSubmission({ text, mode: 'queue', images: [], onRetire: retirement => {
    if (retirement.reason === 'failed') rejectedText = text
  } })
  const transcript = ['Direct Runtime entry discovers the owning computer before the first send.']
  if (projectId !== undefined) transcript.push('The private project draft has a reservation and no stored Session. Its selected model differs from the project default.')
  let submission
  try {
    await disconnect()
    submission = client.prompt([{ type: 'text', text }], 'queue', AbortSignal.timeout(90000), echo.requestId)
    const first = await Promise.race([refused.promise, submission.then(() => undefined)])
    assert.equal(first, 503)
    assert.equal(client.getSnapshot().pendingSubmissions[0]?.text, text)
    assert.equal(slots.size, 1)
    transcript.push('While the computer is offline the original queued input stays visible and unconfirmed.')
    await revokeModel?.()
    await reconnect()
    const result = await submission
    const current = await ownership()
    assert.ok(BigInt(current.generation) > BigInt(original.generation))
    assert.ok(BigInt(current.connection_epoch) > BigInt(original.connection_epoch))
    assert.equal(current.node_connection_epoch, current.connection_epoch)
    assert.equal(slots.size, revokeModel === undefined ? 0 : 1)
    const sends = calls.filter(call => call.path.endsWith('/session.prompt'))
    assert.equal(sends.length, 2)
    assert.deepEqual(sends[0].payload, sends[1].payload)
    assert.ok(calls.slice(1, calls.indexOf(sends[1])).some(call => call.path.endsWith('/session.status') && call.status === 200))
    if (revokeModel === undefined) {
      assert.deepEqual(result, { ok: true, value: { accepted: true } })
    } else {
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'model-forbidden')
      assert.equal(rejectedText, text)
      assert.deepEqual(await unmaterialized(), expectedDraft)
      const catalog = await rpc('session.models', {})
      assert.equal(catalog.ok, true)
      assert.deepEqual(catalog.value.current, preferred)
      assert.equal(catalog.value.routable, false)
      const rejectedId = echo.requestId
      assert.deepEqual(await rpc('session.selectModel', fallback), { ok: true, value: { selected: fallback } })
      expectedDraft.model_selection = fallback
      assert.deepEqual(await unmaterialized(), expectedDraft)
      echo = client.beginSubmission({ text: rejectedText, mode: 'queue', images: [] })
      assert.equal(echo.requestId, rejectedId)
      submission = client.prompt([{ type: 'text', text: rejectedText }], 'queue', AbortSignal.timeout(90000), echo.requestId)
      assert.deepEqual(await submission, { ok: true, value: { accepted: true } })
      assert.equal(slots.size, 0)
      transcript.push('A model revoked offline refuses the recovered send without creating a Session or losing the text. Selecting an allowed model resumes the original submission.')
    }
    if (projectId !== undefined) {
      assert.equal(lostReply, true)
      assert.equal(checkedUnmaterializedReceipt, true)
      const lastSend = calls.findLastIndex(call => call.path.endsWith('/session.prompt'))
      assert.ok(calls.slice(lastSend + 1).some(call => call.path.endsWith('/session.status') && call.status === 200))
      const { rows } = await pool.query(`SELECT c.id,c.visibility,c.cwd,p.public_id::int project,u.public_id::int creator,i.assigned_node_id node
        FROM harness.conversation_sessions c
        JOIN harness.instances i ON (i.organization_id,i.runtime_id)=(c.organization_id,c.runtime_id)
        JOIN harness.projects p ON (p.organization_id,p.id)=(c.organization_id,c.project_id)
        JOIN harness.users u ON (u.organization_id,u.id)=(c.organization_id,c.creator_user_id)
        WHERE c.runtime_id=$1 AND c.id=$2`, [runtimeId, sessionId])
      assert.deepEqual(rows, [{ id: sessionId, visibility: 'private', cwd: created.result.value.workspace.path,
        project: projectId, creator: userId, node: nodeId }])
      assert.equal(await unmaterialized(), undefined)
      transcript.push('Receipt lookup leaves the project draft unmaterialized, and replay retains its original owner and working directory.')
    }
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
        if (projectId !== undefined) {
          const { rows: [record] } = await pool.query(`SELECT event->'data'->'header'->'config' AS config
            FROM harness.conversation_events WHERE runtime_id=$1 AND session_id=$2 AND event_type='request/header' ORDER BY seq LIMIT 1`, [runtimeId, sessionId])
          assert.deepEqual({ provider: record.config.provider, model: record.config.model }, revokeModel === undefined ? preferred : fallback)
        }
        break
      }
      await delay(100, undefined, { signal })
    }
    transcript.push('The owning Runtime records one user input and a complete model reply.')
    if (projectId !== undefined) {
      transcript.push('The durable request uses the draft model that is currently allowed.')
      const opened = await api.sessions.create({ sessionId, draftId, defaultWorkspace: true, visibility: 'private' })
      assert.equal(opened.result.ok, true)
      assert.equal(opened.result.value.sessionId, sessionId)
      assert.deepEqual(await rpc('session.selectModel', fallback), { ok: true, value: { selected: fallback } })
      transcript.push('A delayed draft creation retry keeps ordinary model selection available on the stored Session.')
    }
    const fixture = projectId === undefined ? 'queued-prompt-reconnect.txt'
      : revokeModel === undefined ? 'queued-project-draft-reconnect.txt' : 'queued-project-draft-model-revoked.txt'
    assert.equal(transcript.join('\n') + '\n', await readFile(new URL('../expected/' + fixture, import.meta.url), 'utf8'))
    console.log(JSON.stringify({ scope: 'queued-prompt-reconnect', target: target.kind, leaseChanged: true,
      recoveredUnmaterializedDraft: checkedUnmaterializedReceipt, recoveredCommittedReply: lostReply, durableInputs: 1, completeReply: true,
      ...(projectId === undefined ? {} : { executedModel: revokeModel === undefined ? preferred.model : fallback.model, revokedModelRefused: revokeModel !== undefined }) }))
  } finally {
    client.dispose()
    await submission?.catch(() => {})
    if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage)
    else delete globalThis.sessionStorage
  }
}
