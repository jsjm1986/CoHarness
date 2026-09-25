import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GatewayRequestPrincipal, GatewayRuntimeRequestInit } from '@deepseek-ai/dsh-gateway-runtime'
import type { ExecutionInputId, ExecutionQuestionId, ExecutionState } from '@deepseek-ai/dsh-execution-authority'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { WebhookDeliveryId, WebhookRuleId, WebhookSourceId } from '@deepseek-ai/dsh-webhook'
import { TeamId, TeamMessageId } from '@deepseek-ai/dsh-experimental-agent-team'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GatewayExecution, { type Config } from '../src/index.ts'
import { executionScope, inputDigest } from '../src/input.ts'

const A = '00000000-0000-4000-8000-000000000001' as ExecutionInputId
const B = '00000000-0000-4000-8000-000000000002' as ExecutionInputId
const state = (revision = '1', both = false): ExecutionState => ({
  revision, inputs: both ? [A, B] : [A], actors: both ? [{ userId: 1 }, { userId: 2 }] : [{ userId: 1 }],
  primaryActorUserId: both ? 2 : 1, unverifiedHistory: false,
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(options: { kind?: 'user' | 'project'; config?: Config } = {}) {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionStore)
  const projections = ctx.plugin(SessionProjectionRegistry)
  const agents = new Map<SessionId, Agent>()
  const owners = new Map<SessionId, Agent>()
  let initiator: Agent | undefined
  let preset = 'workspace-write'
  let sandboxMode = 'workspace-write'
  ctx.provide('agents', { get: (id: SessionId) => agents.get(id), list: () => [...agents.values()],
    roots: () => [...agents.values()].filter(agent => !owners.has(agent.id)),
    isOwnedBy: (id: SessionId, owner: Agent) => owners.get(id) === owner, currentInitiator: () => initiator } as never)
  const observeSession = vi.fn<SessionQueryEngine['observeSession']>()
  ctx.provide('sessionQuery', { observeSession } as never)
  ctx.provide('permissionPresets', { current: () => preset } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: sandboxMode }) } as never)
  let stream!: ReadableStreamDefaultController<Uint8Array>
  let current = state()
  let principal: GatewayRequestPrincipal | undefined
  let requestPrincipal: GatewayRequestPrincipal | undefined
  let authorize: (() => Promise<ExecutionState>) | undefined
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const responses = new Map<string, (body: Record<string, unknown>, init?: GatewayRuntimeRequestInit) => Promise<Response>>()
  const request = vi.fn(async (path: string, options?: GatewayRuntimeRequestInit) => {
    if (path.endsWith('/watch')) {
      const respond = responses.get('/watch')
      if (respond !== undefined) return respond({}, options)
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller
        controller.enqueue(new TextEncoder().encode('{"type":"ready"}\n'))
        options?.signal?.addEventListener('abort', () => { controller.error(options.signal?.reason) }, { once: true })
      } })
      return new Response(body)
    }
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) as Record<string, unknown> : {}
    requests.push({ path, body })
    const respond = responses.get(path.slice(path.lastIndexOf('/')))
    if (respond !== undefined) return respond(body, options)
    if (path.endsWith('/register-session')) return new Response(null, { status: 204 })
    if (path.endsWith('/authorize') && authorize !== undefined) return Response.json(await authorize())
    return Response.json(current)
  })
  ctx.provide('gatewayRuntime', { identity: { kind: options.kind ?? 'user', id: 1 },
    interactive: () => principal, current: () => principal ?? requestPrincipal, request } as never)
  const fiber = ctx.plugin(GatewayExecution, options.config)
  cleanups.push(async () => { agents.clear(); await fiber.dispose(); await projections.dispose(); await sessions.dispose() })
  await fiber.await()
  const session = ctx.sessions.create(SessionId('parent'))
  const cancel = vi.fn()
  const agent = { id: session.id, session, ctx, status: 'running', cancel, whenIdle: () => Promise.resolve() } as unknown as Agent
  agents.set(agent.id, agent)
  await vi.waitFor(async () => { expect(await ctx.executionAuthority.authorize('execute', agent)).toEqual(current) })
  return { ctx, agent, agents, owners, requests, request, stream, responses, observeSession, fiber, cancel,
    setPrincipal(value: GatewayRequestPrincipal | undefined) { principal = value },
    setRequestPrincipal(value: GatewayRequestPrincipal | undefined) { requestPrincipal = value },
    setState(value: ExecutionState) { current = value },
    setAuthorize(value: () => Promise<ExecutionState>) { authorize = value },
    setInitiator(value: Agent | undefined) { initiator = value },
    setMode(value: string, sandbox: string = value) { preset = value; sandboxMode = sandbox },
  }
}

function principal(): GatewayRequestPrincipal {
  return {
    assertion: 'verified-interactive',
    claims: {
      version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: 'acme',
      user: { id: 1, username: 'admin', displayName: 'Admin', role: 'admin' }, scope: { kind: 'personal' },
      runtime: { kind: 'user', id: 1, generation: 1 }, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: 'authority-test',
    },
  }
}

function dispatch(): GatewayRequestPrincipal {
  const caller = principal()
  return {
    assertion: 'verified-dispatch',
    claims: { ...caller.claims, purpose: 'webhook-dispatch', nonce: 'dispatch-test' },
  }
}

function webhookSource() {
  return {
    kind: 'webhook' as const, provider: 'github', source: WebhookSourceId('owner/repo'),
    deliveryId: WebhookDeliveryId('delivery-1'), ruleId: WebhookRuleId('rule-1'),
    form: 'notice' as const, summary: 'github webhook handled by rule-1',
  }
}

function observation(header: SessionHeader, events: readonly SessionEvent[] = []): SessionObservation {
  const result: SessionObservation = {
    source: 'prepared', header, events, inheritedEventCount: SessionLogOffset(0),
    cursor: events.length === 0 ? -1 : SessionSeq(events.length - 1),
    [Symbol.dispose]: vi.fn(), retain: () => result,
  }
  return result
}

describe('managed execution identity', () => {
  it('mounts desktop policy with live root routing and keeps a child lease until the whole root is idle', async () => {
    const f = await fixture({ config: { desktop: 'display-0', desktopPollMs: 60_000 } })
    const session = f.ctx.sessions.create(SessionId('desktop-child'))
    const child = { ...f.agent, id: session.id, session } as Agent
    const unrelatedSession = f.ctx.sessions.create(SessionId('unrelated'))
    f.agents.set(unrelatedSession.id, { ...f.agent, id: unrelatedSession.id, session: unrelatedSession })
    f.agents.set(child.id, child)
    f.owners.set(child.id, f.agent)
    f.responses.set('/acquire', async () => Response.json({ status: 'granted', grantId: 'grant', fencing: 1, grantTtlMs: 300_000 }))
    f.responses.set('/heartbeat', async () => Response.json({ status: 'held' }))
    f.responses.set('/release', async () => Response.json({ released: true }))
    await expect(f.ctx.computerUseAuthorization.run({ agent: child, signal: new AbortController().signal } as ToolExecution,
      async () => 'effect')).resolves.toBe('effect')
    expect(f.requests.find(row => row.path.endsWith('/desktop/acquire'))?.body)
      .toMatchObject({ sessionId: child.id, ownerSessionIds: [f.agent.id], desktop: 'display-0' })
    Object.assign(f.agent, { status: 'idle' })
    await f.ctx.serial('agent/status', { agent: f.agent, status: 'idle' } as never)
    expect(f.requests.some(row => row.path.endsWith('/desktop/release'))).toBe(false)
    Object.assign(child, { status: 'idle' })
    await f.ctx.serial('agent/status', { agent: child, status: 'idle' } as never)
    await vi.waitFor(() => {
      expect(f.requests.find(row => row.path.endsWith('/desktop/release'))?.body)
        .toEqual({ sessionId: f.agent.id, ownerSessionIds: [], desktop: 'display-0', grantId: 'grant' })
    })
    f.agents.delete(child.id)
    f.owners.delete(child.id)
    await f.ctx.serial('agent/disposed', { agent: child } as never)
  })

  it.each([null, 'denied'])('refuses a rejected desktop coordinator response and cancels its admission (%s)', async (body) => {
    const f = await fixture({ config: { desktop: 'display-0' } })
    f.responses.set('/acquire', async () => new Response(body, { status: 403 }))
    f.responses.set('/cancel', async () => Response.json({ cancelled: true }))
    const effect = vi.fn()
    await expect(f.ctx.computerUseAuthorization.run({ agent: f.agent, signal: new AbortController().signal } as ToolExecution,
      effect)).rejects.toThrow('Desktop coordination failed (403)')
    expect(effect).not.toHaveBeenCalled()
    expect(f.requests.at(-1)?.path).toBe('/internal/runtime/desktop/cancel')
  })

  it('keeps desktop ownership while an idle root has a running job and reports cleanup failure', async () => {
    const f = await fixture({ config: { desktop: 'display-0', desktopPollMs: 60_000 } })
    const callbacks: Array<(agent?: Agent) => void> = []
    const job = { ownerSession: f.agent.id, status: 'running' }
    f.ctx.provide('jobs', { list: () => [job], onJobsChanged: (callback: (agent?: Agent) => void) => {
      callbacks.push(callback); return () => {}
    } } as never)
    await vi.waitFor(() => { expect(callbacks).toHaveLength(2) })
    f.responses.set('/acquire', async () => Response.json({ status: 'granted', grantId: 'grant', fencing: 1, grantTtlMs: 300_000 }))
    f.responses.set('/heartbeat', async () => Response.json({ status: 'held' }))
    f.responses.set('/release', async () => new Response(null, { status: 503 }))
    await f.ctx.computerUseAuthorization.run({ agent: f.agent, signal: new AbortController().signal } as ToolExecution, async () => 'result')
    Object.assign(f.agent, { status: 'idle' })
    await f.ctx.serial('agent/status', { agent: f.agent, status: 'idle' } as never)
    expect(f.requests.some(row => row.path.endsWith('/release'))).toBe(false)
    for (const callback of callbacks) callback(f.agent)
    await f.ctx.serial('agent/status', { agent: f.agent, status: 'idle' } as never)
    job.status = 'completed'
    for (const callback of callbacks) callback(f.agent)
    await vi.waitFor(() => { expect(f.requests.some(row => row.path.endsWith('/release'))).toBe(true) })
  })

  it('handles qualification invalidation before a desktop confirmation has been requested', async () => {
    const f = await fixture()
    await f.ctx.executionAuthority.authorize('desktop', f.agent)
    f.stream.enqueue(new TextEncoder().encode('{"type":"invalidate","userId":1}\n'))
    await vi.waitFor(() => { expect(f.requests.filter(row => row.path.endsWith('/authorize') && row.body.capability === 'desktop')).toHaveLength(2) })
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('rechecks desktop confirmation on access invalidation even while qualification remains valid', async () => {
    const f = await fixture(), authority = f.ctx.executionAuthority as GatewayExecution
    await authority.authorizeDesktop(f.agent, 'display-0', new AbortController().signal)
    f.responses.set('/desktop-authorize', async () => new Response(null, { status: 403 }))
    f.stream.enqueue(new TextEncoder().encode('{"type":"invalidate","userId":1}\n'))
    await vi.waitFor(() => { expect(f.cancel).toHaveBeenCalledOnce() })
  })

  it('uses live owners for root-shared desktop confirmation and ignores historical parentage', async () => {
    const f = await fixture()
    const session = f.ctx.sessions.create(SessionId('desktop-child'), { meta: { parentSession: f.agent.id } })
    const child = { ...f.agent, id: session.id, session } as Agent
    f.agents.set(child.id, child)
    const authority = f.ctx.executionAuthority as GatewayExecution
    const signal = new AbortController().signal
    await authority.authorizeDesktop(child, 'display-0', signal)
    expect(f.requests.at(-1)?.body).toEqual({ sessionId: child.id, desktop: 'display-0', ownerSessionIds: [] })
    f.owners.set(child.id, f.agent)
    await authority.authorizeDesktop(child, 'display-0', signal)
    expect(f.requests.at(-1)?.body).toEqual({ sessionId: child.id, desktop: 'display-0', ownerSessionIds: [f.agent.id] })
    f.responses.set('/desktop-authorize', async () => { f.owners.delete(child.id); return Response.json(state()) })
    await expect(authority.authorizeDesktop(child, 'display-0', signal)).rejects.toThrow(/ownership changed/)
  })

  it('refuses incomplete or cyclic live desktop ownership instead of consulting stored lineage', async () => {
    const f = await fixture(), authority = f.ctx.executionAuthority as GatewayExecution
    const missing = { ...f.agent, id: SessionId('missing') } as Agent
    f.owners.set(f.agent.id, missing)
    await expect(authority.authorizeDesktop(f.agent, 'display-0', new AbortController().signal)).rejects.toThrow(/ownership chain/)
    f.agents.set(missing.id, missing)
    f.owners.set(missing.id, f.agent)
    await expect(authority.authorizeDesktop(f.agent, 'display-0', new AbortController().signal)).rejects.toThrow(/ownership chain/)
  })

  it('rejects a desktop confirmation response after the caller cancels or detaches', async () => {
    const f = await fixture(), authority = f.ctx.executionAuthority as GatewayExecution
    const controller = new AbortController()
    f.responses.set('/desktop-authorize', async () => { controller.abort(new Error('cancelled')); return Response.json(state()) })
    await expect(authority.authorizeDesktop(f.agent, 'display-0', controller.signal)).rejects.toThrow()
    f.responses.set('/desktop-authorize', async () => { f.agents.delete(f.agent.id); return Response.json(state()) })
    await expect(authority.authorizeDesktop(f.agent, 'display-0', new AbortController().signal)).rejects.toThrow(/ownership changed/)
  })

  it('offers Full access only to a live administrator and removes the policy on unload', async () => {
    const f = await fixture()
    const policy = f.ctx.get('permissionPresetAuthorization')!
    expect(policy.canSelect('workspace-write')).toBe(true)
    expect(policy.canSelect('danger-full-access')).toBe(false)
    const principal = { claims: { user: { role: 'user' } } } as GatewayRequestPrincipal
    f.setPrincipal(principal)
    expect(policy.canSelect('danger-full-access')).toBe(false)
    f.setPrincipal({ ...principal, claims: { ...principal.claims, user: { ...principal.claims.user, role: 'admin' } } })
    expect(policy.canSelect('danger-full-access')).toBe(true)
    f.setPrincipal(undefined)
    expect(policy.canSelect('danger-full-access')).toBe(false)
    await cleanups.pop()!()
    expect(f.ctx.get('permissionPresetAuthorization')).toBeUndefined()
    expect(f.ctx.get('pluginManagementAuthorization')).toBeUndefined()
  })

  it('rejects a delayed authorization after another participant enters', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<ExecutionState>()
    f.setAuthorize(() => { entered.resolve(undefined); return reply.promise })
    const pending = f.ctx.executionAuthority.authorize('plugin-management', f.agent)
    const rejected = expect(pending).rejects.toThrow(/changed while/)
    await entered.promise
    f.agent.session.append('gateway/execution', { kind: 'accepted', state: state('2', true) })
    reply.resolve(state())
    await rejected
    expect(f.ctx.executionAuthority.capture(f.agent).inputs).toEqual([A, B])
  })

  it('rejects a response from a disconnected authorization stream and cancels active work', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<ExecutionState>()
    f.setAuthorize(() => { entered.resolve(undefined); return reply.promise })
    const pending = f.ctx.executionAuthority.authorize('plugin-management', f.agent)
    const rejected = expect(pending).rejects.toThrow(/changed while/)
    await entered.promise
    f.stream.close()
    await vi.waitFor(() => { expect(f.cancel).toHaveBeenCalledOnce() })
    reply.resolve(state())
    await rejected
  })

  it('does not reuse a seeded parent revision as the child authority revision', async () => {
    const f = await fixture()
    f.agent.session.append('gateway/execution', { kind: 'accepted', state: state('99', true) })
    const scope = f.ctx.executionAuthority.capture(f.agent)
    const seed = Array.from({ length: f.agent.session.seq }, (_, seq) => f.agent.session.eventAt(seq as never)!)
    const childSession = f.ctx.sessions.create(SessionId('child'), {
      seed, meta: { parentSession: f.agent.id, isSeeded: true }, inheritedEventCount: SessionLogOffset(seed.length),
    })
    f.ctx.executionAuthority.inherit(childSession, scope)
    const child = { ...f.agent, id: childSession.id, session: childSession } as Agent
    f.agents.set(child.id, child)
    f.setState(state('1', true))
    await expect(f.ctx.executionAuthority.authorize('execute', child)).resolves.toMatchObject({ revision: '1' })
    expect(f.ctx.executionAuthority.capture(child).inputs).toEqual([A, B])
  })

  it('marks unsigned later human input unknown even in a delegated child', async () => {
    const f = await fixture()
    f.ctx.executionAuthority.inherit(f.agent.session, f.ctx.executionAuthority.capture(f.agent))
    const message = createUserMessage({ content: [{ type: 'text', text: 'unverified editor' }], source: { kind: 'user' } })
    const event = f.agent.session.append('user/message', message, { surfaceOp: 'append' })
    await f.ctx.serial('agent/message-entered', { agent: f.agent, event, signal: new AbortController().signal } as never)
    await expect(f.ctx.executionAuthority.authorize('plugin-management', f.agent)).rejects.toThrow(/without verified human identity/)
  })

  it('verifies transformed human input against its original content digest', async () => {
    const f = await fixture()
    const message = createUserMessage({ content: [{ type: 'text', text: '@parent help' }],
      source: { kind: 'user', gatewayExecutionInput: A } })
    await f.ctx.waterfall('agent/pre-step', { agent: f.agent, messages: [message] } as never, async () => ({ kind: 'enter', messages: [message] }))
    const event = f.agent.session.append('user/message', { ...message, content: [{ type: 'text', text: 'help' }] }, { surfaceOp: 'append' })
    await f.ctx.serial('agent/message-entered', { agent: f.agent, event, signal: new AbortController().signal } as never)
    expect(f.requests.find(row => row.path.endsWith('/enter'))?.body).toMatchObject({ inputId: A, contentHash: inputDigest(message.content) })
  })

  it('stamps only a live caller and preserves an earlier editor reference', async () => {
    const f = await fixture()
    const message = createUserMessage({ content: [{ type: 'text', text: 'edited' }], source: { kind: 'user', gatewayExecutionInput: A } })
    await expect(f.ctx.executionAuthority.stamp(f.agent.session, message)).rejects.toThrow(/interactive caller/)
    const principal = { claims: { user: { id: 2 } } } as GatewayRequestPrincipal
    f.setPrincipal(principal)
    f.request.mockImplementationOnce(async () => Response.json({ inputId: B }))
    const edited = await f.ctx.executionAuthority.stamp(f.agent.session, message)
    expect(edited.source).toMatchObject({ gatewayExecutionInput: B })
    const call = f.request.mock.calls.at(-1)!
    const postedBody = call[1]?.body
    if (typeof postedBody !== 'string') throw new Error('expected JSON request body')
    expect(JSON.parse(postedBody)).toMatchObject({
      previousInputId: A, contentHash: inputDigest(message.content), messageId: message.id,
    })
    expect(call[1]).toMatchObject({ principal })
    expect(Object.isFrozen(edited)).toBe(true)
  })

  it('stamps a managed webhook dispatch admission through its purpose-bound assertion', async () => {
    const f = await fixture()
    const caller = dispatch()
    f.setRequestPrincipal(caller)
    f.responses.set('/input', async () => Response.json({ inputId: B }))
    const message = createUserMessage({ content: [{ type: 'text', text: 'dispatch' }], source: webhookSource() })
    const stamped = await f.ctx.executionAuthority.stamp(f.agent.session, message)
    expect(stamped.source).toMatchObject({ gatewayExecutionInput: B })
    const call = f.request.mock.calls.at(-1)!
    expect(call[0]).toBe('/internal/runtime/execution/input')
    expect(call[1]).toMatchObject({ principal: caller })
    expect(JSON.parse(call[1]?.body as string)).toMatchObject({ messageId: message.id, kind: 'message' })
  })

  it('selects a privileged preset under the managed dispatch assertion', async () => {
    const f = await fixture()
    const caller = dispatch()
    f.setRequestPrincipal(caller)
    await f.ctx.executionAuthority.authorizeSelection(f.agent, 'auto')
    expect(f.request).toHaveBeenLastCalledWith('/internal/runtime/execution/selection',
      expect.objectContaining({ principal: caller }))
  })

  it.each([undefined, 'terminal-admin', 'plugin-admin'] as const)(
    'refuses input stamping without an interactive caller or dispatch assertion (%s)', async (purpose) => {
      const f = await fixture()
      if (purpose !== undefined) {
        const caller = dispatch()
        f.setRequestPrincipal({ ...caller, claims: { ...caller.claims, purpose } })
      }
      const message = createUserMessage({ content: [{ type: 'text', text: 'dispatch' }], source: webhookSource() })
      await expect(f.ctx.executionAuthority.stamp(f.agent.session, message)).rejects.toThrow(/interactive caller/)
    })

  it('refuses input stamping under a purpose-bound interactive caller', async () => {
    const f = await fixture()
    f.setPrincipal(dispatch())
    const message = createUserMessage({ content: [{ type: 'text', text: 'dispatch' }], source: webhookSource() })
    await expect(f.ctx.executionAuthority.stamp(f.agent.session, message)).rejects.toThrow(/interactive caller/)
  })

  it('carries the exact sender and stable message identity into relay verification', async () => {
    const f = await fixture()
    const message = createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: {
      kind: 'agent-message', form: 'relay', senderSessionId: SessionId('child'),
      gatewayExecutionScope: { parentSessionId: SessionId('child'), inputs: [B], primaryActorUserId: 2, unverifiedHistory: false },
    } })
    f.setState(state('2', true))
    const event = f.agent.session.append('user/message', message, { surfaceOp: 'append' })
    await f.ctx.serial('agent/message-entered', { agent: f.agent, event, signal: new AbortController().signal } as never)
    expect(f.requests.find(row => row.path.endsWith('/relay'))?.body).toMatchObject({ senderSessionId: 'child', inputs: [B], primaryActorUserId: 2, messageId: message.id })
    expect(f.ctx.executionAuthority.capture(f.agent).inputs).toEqual([A, B])
  })

  it('keeps an unknown relay restrictive after restoring the Session log', async () => {
    const f = await fixture()
    const message = createUserMessage({ content: [{ type: 'text', text: 'legacy child result' }], source: {
      kind: 'agent-message', form: 'relay', senderSessionId: SessionId('child'),
    } })
    f.agent.session.append('user/message', message, { surfaceOp: 'append' })
    await expect(f.ctx.executionAuthority.authorize('auto-review', f.agent)).rejects.toThrow(/without verified human identity/)
    expect(f.ctx.executionAuthority.capture(f.agent).unverifiedHistory).toBe(true)
  })

  it('cancels and awaits background work even after its Agent becomes idle', async () => {
    const f = await fixture()
    await f.ctx.executionAuthority.authorize('plugin-management', f.agent)
    Object.assign(f.agent, { status: 'idle' })
    const job = { id: 'bash-1', ownerSession: f.agent.id, status: 'running' }
    const released = Promise.withResolvers<never>()
    const kill = vi.fn(() => { job.status = 'stopping'; return 'requested' })
    const wait = vi.fn(() => released.promise)
    f.ctx.provide('jobs', { list: () => [job], kill, wait, onJobsChanged: () => () => {} } as never)
    f.setAuthorize(async () => { throw new Error('administrator revoked') })
    f.stream.enqueue(new TextEncoder().encode('{"type":"invalidate","userId":1}\n'))
    try {
      await vi.waitFor(() => { expect(kill).toHaveBeenCalledWith('bash-1', f.agent, expect.stringContaining('revoked')) })
      expect(wait).toHaveBeenCalledWith('bash-1', 30_000, f.agent)
      expect(job.status).toBe('stopping')
      job.status = 'killed'
      released.resolve({ ...job } as never)
    } finally {
      job.status = 'killed'
      released.resolve({ ...job } as never)
    }
  })

  it('removes an idle Agent grant when its last background job settles', async () => {
    const f = await fixture()
    f.setInitiator(f.agent)
    await f.ctx.executionAuthority.authorize('plugin-management', f.agent)
    const policy = f.ctx.get('permissionPresetAuthorization')!
    expect(policy.canSelect('danger-full-access')).toBe(true)
    let notify: ((agent?: Agent) => void) | undefined
    f.ctx.provide('jobs', {
      list: () => [{ ownerSession: SessionId('other'), status: 'running' },
        { ownerSession: f.agent.id, status: 'completed' }],
      onJobsChanged: (listener: (agent?: Agent) => void) => { notify = listener; return () => {} },
    } as never)
    await vi.waitFor(() => { expect(notify).toBeDefined() })
    Object.assign(f.agent, { status: 'idle' })
    notify?.(undefined)
    expect(policy.canSelect('danger-full-access')).toBe(true)
    notify?.(f.agent)
    expect(policy.canSelect('danger-full-access')).toBe(false)
  })

  it('does not accept an old privilege response after an invalidation on the same connection', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<ExecutionState>()
    let calls = 0
    f.setAuthorize(() => {
      if (calls++ === 0) { entered.resolve(undefined); return reply.promise }
      return Promise.resolve(state())
    })
    const pending = f.ctx.executionAuthority.authorize('plugin-management', f.agent)
    const rejected = expect(pending).rejects.toThrow(/changed while/)
    await entered.promise
    f.stream.enqueue(new TextEncoder().encode('{"type":"invalidate","userId":1}\n'))
    await vi.waitFor(() => { expect(calls).toBeGreaterThan(1) })
    reply.resolve(state())
    await rejected
  })

  it.each([
    ['malformed JSON', '{bad}\n'],
    ['missing type', '{}\n'],
    ['unknown type', '{"type":"unknown"}\n'],
    ['invalid user', '{"type":"invalidate","userId":0}\n'],
    ['non-numeric user', '{"type":"invalidate","userId":"1"}\n'],
    ['invalid project', '{"type":"invalidate","projectId":0}\n'],
    ['non-numeric project', '{"type":"invalidate","projectId":"1"}\n'],
    ['oversized line', `${'x'.repeat(8193)}\n`],
    ['oversized unfinished frame', 'x'.repeat(8193)],
  ])('fails closed on a %s authorization update', async (_name, payload) => {
    const f = await fixture()
    f.responses.set('/watch', async () => new Response(null, { status: 503 }))
    f.stream.enqueue(new TextEncoder().encode('{"type":"heartbeat"}\n' + payload))
    await vi.waitFor(() => { expect(f.cancel).toHaveBeenCalledOnce() })
    await expect(f.ctx.executionAuthority.authorize('execute', f.agent)).rejects.toThrow(/unavailable/)
  })

  it('cancels a rejected watch body and reconnects only after failing closed', async () => {
    const f = await fixture({ config: { reconnectDelayMs: 1 } })
    const cancelled = vi.fn()
    const refused = vi.fn(async () => {
      f.responses.delete('/watch')
      return new Response(new ReadableStream({ cancel: cancelled }), { status: 503 })
    })
    f.responses.set('/watch', refused)
    f.stream.close()
    await vi.waitFor(() => { expect(refused).toHaveBeenCalledOnce(); expect(cancelled).toHaveBeenCalledOnce() })
    expect(f.cancel).toHaveBeenCalled()
  })

  it('reports a background job that does not release after revocation', async () => {
    const f = await fixture({ config: { jobStopTimeoutMs: 2500 } })
    await f.ctx.executionAuthority.authorize('plugin-management', f.agent)
    const job = { id: 'stuck-job', ownerSession: f.agent.id, status: 'running' }
    const kill = vi.fn()
    const wait = vi.fn(async () => job)
    f.ctx.provide('jobs', { list: () => [job], kill, wait, onJobsChanged: () => () => {} } as never)
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    f.setAuthorize(async () => { throw new Error('permission revoked') })
    f.stream.enqueue(new TextEncoder().encode('{"type":"invalidate","userId":1}\n'))
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('Gateway execution cancellation did not settle: %o', expect.any(AggregateError)) })
    expect(kill).toHaveBeenCalledWith('stuck-job', f.agent, expect.stringContaining('revoked'))
    expect(wait).toHaveBeenCalledWith('stuck-job', 2500, f.agent)
    warn.mockRestore()
  })

  it.each([
    ['user', { projectId: 1 }, { userId: 1 }],
    ['project', { projectId: 2 }, { projectId: 1 }],
  ] as const)('ignores unrelated %s invalidations and rechecks the matching scope', async (kind, unrelated, matching) => {
    const f = await fixture({ kind })
    const checked = vi.fn(async () => state())
    f.setAuthorize(checked)
    const updates = [unrelated, { userId: 99 }, matching]
      .map(subject => JSON.stringify({ type: 'invalidate', ...subject }) + '\n').join('')
    f.stream.enqueue(new TextEncoder().encode(updates))
    await vi.waitFor(() => { expect(checked).toHaveBeenCalledOnce() })
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('does not restart an idle Agent with no owned jobs after invalidation', async () => {
    const f = await fixture({ config: { reconnectDelayMs: 1 } })
    Object.assign(f.agent, { status: 'idle' })
    const checked = vi.fn(async () => state())
    f.setAuthorize(checked)
    const retry = vi.fn(async () => new Response(null, { status: 503 }))
    f.responses.set('/watch', retry)
    f.stream.enqueue(new TextEncoder().encode('{"type":"invalidate","userId":1}\n{bad}\n'))
    await vi.waitFor(() => { expect(retry).toHaveBeenCalled() })
    expect(checked).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('rechecks ordinary execution when an Agent has no cached privilege', async () => {
    const f = await fixture()
    await f.ctx.serial('agent/disposed', { agent: f.agent } as never)
    const checked = vi.fn(async () => state())
    f.setAuthorize(checked)
    f.stream.enqueue(new TextEncoder().encode('{"type":"invalidate","userId":1}\n'))
    await vi.waitFor(() => { expect(checked).toHaveBeenCalledOnce() })
    expect(f.requests.at(-1)?.body).toMatchObject({ capability: 'execute' })
  })

  it('does not cancel a replacement Agent after an earlier instance loses permission', async () => {
    const f = await fixture()
    const replacement = { ...f.agent } as Agent
    const checked = Promise.withResolvers<undefined>()
    f.setAuthorize(async () => {
      f.agents.set(f.agent.id, replacement)
      checked.resolve(undefined)
      throw new Error('old instance was revoked')
    })
    f.stream.enqueue(new TextEncoder().encode('{"type":"invalidate","userId":1}\n'))
    await checked.promise
    await cleanups.pop()!()
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('rejects forged empty inheritance and malformed durable references', () => {
    expect(() => executionScope({ parentSessionId: 'p', inputs: [], unverifiedHistory: false })).toThrow()
    expect(() => executionScope({ parentSessionId: 'p', inputs: [A], unverifiedHistory: false })).toThrow()
    expect(() => executionScope({ parentSessionId: 'p', inputs: [A, A], primaryActorUserId: 1, unverifiedHistory: false })).toThrow()
  })

  it('rechecks interactive Full defaults and uses the actual Agent for background profile operations', async () => {
    const f = await fixture()
    const selection = f.ctx.get('permissionPresetAuthorization')!
    const management = f.ctx.get('pluginManagementAuthorization')!
    await expect(selection.authorizeDefault?.('workspace-write')).resolves.toBeUndefined()
    await expect(selection.authorizeDefault?.('danger-full-access')).rejects.toMatchObject({ code: 'plugin-management/forbidden' })
    const caller = principal()
    f.setPrincipal(caller)
    f.responses.set('/authorize', async (_body, init) => init?.principal === undefined
      ? Response.json(state()) : new Response(null, { status: 204 }))
    await selection.authorizeDefault?.('danger-full-access')
    await management.authorize()
    expect(f.request).toHaveBeenLastCalledWith('/internal/runtime/plugin-management/authorize', expect.objectContaining({ principal: caller }))
    f.setPrincipal(undefined)
    f.setInitiator(f.agent)
    expect(selection.canSelect('danger-full-access')).toBe(false)
    await management.authorize()
    expect(selection.canSelect('danger-full-access')).toBe(true)
    await f.ctx.serial('agent/status', { agent: f.agent, status: 'running' } as never)
    expect(selection.canSelect('danger-full-access')).toBe(true)
    await f.ctx.serial('agent/status', { agent: f.agent, status: 'idle' } as never)
    expect(selection.canSelect('danger-full-access')).toBe(false)
    await management.authorize()
    await f.ctx.serial('agent/disposed', { agent: f.agent } as never)
    expect(selection.canSelect('danger-full-access')).toBe(false)
  })

  it('drains a refused profile authorization response before reporting denial', async () => {
    const f = await fixture()
    f.setPrincipal(principal())
    const cancelled = vi.fn()
    f.responses.set('/authorize', async (_body, init) => init?.principal === undefined
      ? Response.json(state())
      : new Response(new ReadableStream({ cancel: cancelled }), { status: 403 }))
    await expect(f.ctx.get('pluginManagementAuthorization')?.authorize()).rejects.toMatchObject({
      code: 'plugin-management/forbidden',
    })
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('checks privileged selections without adding ordinary selection traffic', async () => {
    const f = await fixture()
    const policy = f.ctx.get('permissionPresetAuthorization')!
    const before = f.requests.length
    await policy.authorizeSelection?.(f.agent, 'workspace-write')
    expect(f.requests).toHaveLength(before)
    await policy.authorizeSelection?.(f.agent, 'danger-full-access')
    expect(f.requests.at(-1)?.body).toMatchObject({ sessionId: f.agent.id, capability: 'plugin-management' })
    f.setPrincipal(principal())
    f.responses.set('/selection', async () => new Response(null, { status: 204 }))
    await policy.authorizeSelection?.(f.agent, 'auto')
    expect(f.requests.at(-1)).toMatchObject({ path: '/internal/runtime/execution/selection', body: { capability: 'auto-review' } })
    f.responses.set('/selection', async () => new Response(null, { status: 403 }))
    await expect(policy.authorizeSelection?.(f.agent, 'danger-full-access')).rejects.toMatchObject({ code: 'execution/forbidden' })
  })

  it.each([
    ['workspace-write', 'execute'], ['danger-full-access', 'plugin-management'], ['auto', 'auto-review'],
  ])('checks %s before a model request and an allowed owned tool', async (mode, capability) => {
    const f = await fixture()
    f.setMode(mode)
    const signal = new AbortController().signal
    const model = { provider: 'test-provider', model: 'test-model' }
    const continuation = vi.fn(async () => model)
    await expect(f.ctx.waterfall('agent/request', { agent: f.agent, signal } as never, continuation)).resolves.toBe(model)
    expect(f.requests.at(-1)?.body).toMatchObject({ capability })
    expect(continuation).toHaveBeenCalledOnce()
    const allowed = { kind: 'allow' as const }
    const exec = { agent: f.agent, signal } as never
    await expect(f.ctx.waterfall('tools/pre-execute', exec, async () => allowed)).resolves.toBe(allowed)
    const before = f.requests.length
    const denied = { kind: 'deny' as const, reason: 'owned guard refusal' }
    await expect(f.ctx.waterfall('tools/pre-execute', exec, async () => denied)).resolves.toBe(denied)
    await f.ctx.waterfall('tools/pre-execute', { signal } as never, async () => allowed)
    expect(f.requests).toHaveLength(before)
    f.setAuthorize(async () => { throw new Error('revoked before dispatch') })
    await expect(f.ctx.waterfall('agent/request', { agent: f.agent, signal } as never, continuation)).rejects.toThrow('revoked before dispatch')
    expect(continuation).toHaveBeenCalledOnce()
  })

  it('attests new input without inventing an earlier editor and refuses malformed attestations', async () => {
    const f = await fixture()
    const message = createUserMessage({ content: [{ type: 'text', text: 'new instruction' }], source: { kind: 'user' } })
    f.setPrincipal(principal())
    f.responses.set('/input', async () => Response.json({ inputId: A }))
    await expect(f.ctx.executionAuthority.stamp(f.agent.session, message)).resolves.toMatchObject({ source: { gatewayExecutionInput: A } })
    expect(f.requests.at(-1)?.body).not.toHaveProperty('previousInputId')
    for (const reply of [null, 1, {}, { inputId: 1 }, { inputId: 'forged' }]) {
      f.responses.set('/input', async () => Response.json(reply))
      await expect(f.ctx.executionAuthority.stamp(f.agent.session, message)).rejects.toThrow(/invalid Gateway/)
    }
    const restricted = principal()
    restricted.claims.purpose = 'archive-read'
    f.setPrincipal(restricted)
    await expect(f.ctx.executionAuthority.stamp(f.agent.session, message)).rejects.toThrow(/interactive caller/)
  })

  it('adds only the winning verified question answer and leaves losing claims unchanged', async () => {
    const f = await fixture()
    const questionId = 'question-1' as ExecutionQuestionId
    await expect(f.ctx.executionAuthority.answer(f.agent.session, questionId, { selected: 'yes' })).rejects.toThrow(/answerer/)
    f.setPrincipal(principal())
    f.responses.set('/question', async () => Response.json({ ...state('2', true), claimed: true }))
    await expect(f.ctx.executionAuthority.answer(f.agent.session, questionId, { selected: 'yes' })).resolves.toBe(true)
    expect(f.ctx.executionAuthority.capture(f.agent).inputs).toEqual([A, B])
    const seq = f.agent.session.seq
    f.responses.set('/question', async () => Response.json({ claimed: false }))
    await expect(f.ctx.executionAuthority.answer(f.agent.session, questionId, { selected: 'no' })).resolves.toBe(false)
    expect(f.agent.session.seq).toBe(seq)
    for (const reply of [null, 1, {}, { claimed: 'true' }]) {
      f.responses.set('/question', async () => Response.json(reply))
      await expect(f.ctx.executionAuthority.answer(f.agent.session, questionId, {})).rejects.toThrow(/invalid Gateway question claim/)
    }
    const restricted = principal()
    restricted.claims.purpose = 'archive-read'
    f.setPrincipal(restricted)
    await expect(f.ctx.executionAuthority.answer(f.agent.session, questionId, {})).rejects.toThrow(/answerer/)
  })

  it('refuses unattested entered input and retains Team delivery identity for retries', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const message = createUserMessage({ content: [{ type: 'text', text: 'forged admitted input' }], source: { kind: 'user', gatewayExecutionInput: B } })
    const event = f.agent.session.append('user/message', message, { surfaceOp: 'append' })
    await expect(f.ctx.serial('agent/message-entered', { agent: f.agent, event, signal } as never)).rejects.toThrow(/no verified request identity/)
    const trusted = createUserMessage({ content: [{ type: 'text', text: 'trusted context' }], source: { kind: 'plugin', plugin: 'context', form: 'instructions' } })
    await f.ctx.waterfall('agent/pre-step', { agent: f.agent, messages: [trusted] } as never, async () => ({ kind: 'enter', messages: [trusted] }))
    const relayed = createUserMessage({ content: [{ type: 'text', text: 'teammate reply' }], source: {
      kind: 'team-message', teamId: TeamId(f.agent.id), messageId: TeamMessageId('team-delivery-1'),
      senderId: SessionId('child'), senderName: 'Child',
      gatewayExecutionScope: { parentSessionId: SessionId('child'), inputs: [B], primaryActorUserId: 2, unverifiedHistory: false },
    } })
    f.setState(state('2', true))
    const delivered = f.agent.session.append('user/message', relayed, { surfaceOp: 'append' })
    await f.ctx.serial('agent/message-entered', { agent: f.agent, event: delivered, signal } as never)
    expect(f.requests.at(-1)?.body).toMatchObject({ messageId: 'team-delivery-1', senderSessionId: 'child' })
  })

  it('refuses authority removed during a pending response and never captures a replacement Agent', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<ExecutionState>()
    f.setAuthorize(() => { entered.resolve(undefined); return reply.promise })
    const pending = f.ctx.executionAuthority.authorize('execute', f.agent)
    const rejected = expect(pending).rejects.toThrow(/changed while/)
    await entered.promise
    f.agents.delete(f.agent.id)
    reply.resolve(state())
    await rejected
    expect(() => f.ctx.executionAuthority.capture(f.agent)).toThrow(/no longer active/)
    await expect(f.ctx.executionAuthority.authorize('execute', f.agent)).rejects.toThrow(/unavailable/)
  })

  it('does not accept a completed permission response after operation cancellation', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<ExecutionState>()
    const controller = new AbortController()
    f.setAuthorize(() => { entered.resolve(undefined); return reply.promise })
    const pending = f.ctx.executionAuthority.authorize('execute', f.agent, controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await entered.promise
    controller.abort(new Error('owned call cancelled'))
    reply.resolve(state())
    await rejected
    expect(f.request.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true)
  })

  it('drains refused response bodies before exposing an authorization error', async () => {
    const f = await fixture()
    const cancelled = vi.fn()
    f.responses.set('/authorize', async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 403 }))
    await expect(f.ctx.executionAuthority.authorize('execute', f.agent)).rejects.toMatchObject({ code: 'execution/forbidden' })
    expect(cancelled).toHaveBeenCalledOnce()
    const retained = f.ctx.executionAuthority
    await cleanups.pop()!()
    await expect(retained.stamp(f.agent.session, createUserMessage({ content: [], source: { kind: 'user' } }))).rejects.toThrow()
  })

  it('captures a live fork source without discarding contributors outside a chosen transcript prefix', async () => {
    const f = await fixture()
    f.agent.session.append('gateway/execution', { kind: 'accepted', state: state('4', true) })
    f.setState(state('4', true))
    expect(await f.ctx.executionAuthority.captureSession(f.agent.id)).toEqual({
      parentSessionId: f.agent.id, inputs: [A, B], primaryActorUserId: 2, unverifiedHistory: false,
    })
    expect(f.observeSession).not.toHaveBeenCalled()
    expect(f.requests.at(-1)).toMatchObject({ path: '/internal/runtime/execution/capture', body: { sessionId: f.agent.id } })
  })

  it.each(['clean', 'accepted', 'inherit', 'human', 'context', 'other'] as const)('retains %s cold-history restrictions and releases its observation', async (kind) => {
    const f = await fixture()
    const cold = f.ctx.sessions.prepare(SessionId(`cold-${kind}`))
    const events: SessionEvent[] = []
    if (kind === 'accepted') events.push(cold.append('gateway/execution', { kind: 'accepted', state: { ...state(), unverifiedHistory: true } }))
    if (kind === 'inherit') events.push(cold.append('gateway/execution', { kind: 'inherit', scope: {
      parentSessionId: f.agent.id, inputs: [A], primaryActorUserId: 1, unverifiedHistory: true,
    } }))
    if (kind === 'human' || kind === 'context') events.push(cold.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'restored input' }],
      source: kind === 'human' ? { kind: 'user' } : { kind: 'plugin', plugin: 'context', form: 'instructions' },
    }), { surfaceOp: 'append' }))
    if (kind === 'other') events.push(cold.append('turn/start', { turn: 1 }))
    const observed = observation(cold.header, events)
    f.observeSession.mockResolvedValueOnce(observed)
    const captured = await f.ctx.executionAuthority.captureSession(cold.id)
    expect(captured.unverifiedHistory).toBe(kind === 'accepted' || kind === 'inherit' || kind === 'human')
    expect(observed[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(f.ctx.sessions.get(cold.id)).toBeUndefined()
  })

  it('captures an empty cold source as unknown and does not create privileged identity', async () => {
    const f = await fixture()
    const cold = f.ctx.sessions.prepare(SessionId('empty-cold'))
    f.observeSession.mockResolvedValueOnce(observation(cold.header))
    f.responses.set('/capture', async () => Response.json({ revision: '0', inputs: [], actors: [], unverifiedHistory: false }))
    await expect(f.ctx.executionAuthority.captureSession(cold.id)).resolves.toEqual({
      parentSessionId: cold.id, inputs: [], unverifiedHistory: true,
    })
  })

  it('registers a shared cold ancestor once before admitting concurrent children', async () => {
    const f = await fixture()
    const parent = f.ctx.sessions.prepare(SessionId('cold-ancestor'))
    const observed = observation(parent.header)
    f.observeSession.mockResolvedValue(observed)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    f.responses.set('/register-session', async (body) => {
      if (body.sessionId === parent.id) { entered.resolve(undefined); await release.promise }
      return new Response(null, { status: 204 })
    })
    const children = ['left', 'right'].map((name) => {
      const session = f.ctx.sessions.create(SessionId(name), { meta: { parentSession: parent.id } })
      const agent = { ...f.agent, id: session.id, session } as Agent
      f.agents.set(agent.id, agent)
      return agent
    })
    const left = f.ctx.serial('agent/created', { agent: children[0] } as never)
    await entered.promise
    const right = f.ctx.serial('agent/created', { agent: children[1] } as never)
    try {
      expect(f.requests.filter(row => row.path.endsWith('/register-session') && row.body.sessionId !== f.agent.id))
        .toEqual([{ path: '/internal/runtime/execution/register-session', body: { sessionId: parent.id, isSeeded: false } }])
    } finally { release.resolve(undefined) }
    await Promise.all([left, right])
    const registered = f.requests.filter(row => row.path.endsWith('/register-session')).map(row => row.body.sessionId)
    expect(registered.filter(id => id === parent.id)).toHaveLength(1)
    expect(registered.indexOf(parent.id)).toBeLessThan(registered.indexOf('left'))
    expect(registered.indexOf(parent.id)).toBeLessThan(registered.indexOf('right'))
    expect(observed[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('flushes an unpublished project header before registration and retries a refused registration', async () => {
    const f = await fixture({ kind: 'project' })
    const child = f.ctx.sessions.prepare(SessionId('project-draft'))
    const agent = { ...f.agent, id: child.id, session: child } as Agent
    const flushed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      expect(session).toBe(child)
      flushed.resolve(undefined)
      await release.promise
      return true
    })
    let attempts = 0
    f.responses.set('/register-session', async () => new Response(null, { status: attempts++ === 0 ? 503 : 204 }))
    const first = f.ctx.serial('agent/created', { agent } as never)
    const refused = expect(first).rejects.toMatchObject({ code: 'execution/forbidden' })
    await flushed.promise
    expect(f.requests.filter(row => row.body.sessionId === child.id)).toHaveLength(0)
    release.resolve(undefined)
    await refused
    await f.ctx.serial('agent/created', { agent } as never)
    expect(attempts).toBe(2)
    expect(flush).toHaveBeenCalledTimes(2)
    flush.mockRestore()
  })

  it.each(['self', 'ancestor-alias'] as const)('rejects a %s cold lineage cycle and releases every observation', async (kind) => {
    const f = await fixture()
    const id = SessionId('cycle')
    const observed = observation({ ...f.agent.session.header, id, parentSession: kind === 'self' ? id : SessionId('parent-alias') })
    f.observeSession.mockResolvedValue(observed)
    await expect(f.ctx.executionAuthority.captureSession(id)).rejects.toThrow(/lineage contains a cycle/)
    expect(observed[Symbol.dispose]).toHaveBeenCalledTimes(kind === 'self' ? 1 : 2)
  })

  it('refuses participant removal and same-revision rewriting, while preserving a newer accepted result', async () => {
    const f = await fixture()
    f.setPrincipal(principal())
    const answer = () => f.ctx.executionAuthority.answer(f.agent.session, 'question' as ExecutionQuestionId, {})
    f.responses.set('/question', async () => Response.json({ ...state('1', true), claimed: true }))
    await expect(answer()).rejects.toThrow(/without advancing/)
    f.agent.session.append('gateway/execution', { kind: 'accepted', state: state('3', true) })
    f.responses.set('/question', async () => Response.json({ ...state('2', true), claimed: true }))
    await expect(answer()).resolves.toBe(true)
    expect(f.ctx.sessionProjections.stateOf(f.agent.session, 'gateway-execution')?.state.revision).toBe('3')
    f.responses.set('/question', async () => Response.json({ ...state('4'), claimed: true }))
    await expect(answer()).rejects.toThrow(/participants cannot be removed/)
    f.agent.session.append('gateway/execution', { kind: 'accepted', state: { ...state('5', true), unverifiedHistory: true } })
    f.responses.set('/question', async () => Response.json({ ...state('6', true), claimed: true }))
    await expect(answer()).rejects.toThrow(/participants cannot be removed/)
  })

  it('keeps a seeded session unknown until its own verified inheritance is recorded', async () => {
    const f = await fixture()
    const session = f.ctx.sessions.create(SessionId('seeded'), {
      seed: [], meta: { isSeeded: true }, inheritedEventCount: SessionLogOffset(0),
    })
    const agent = { ...f.agent, id: session.id, session } as Agent
    f.agents.set(agent.id, agent)
    expect(f.ctx.executionAuthority.capture(agent)).toMatchObject({ inputs: [], unverifiedHistory: true })
    await expect(f.ctx.executionAuthority.authorize('auto-review', agent)).rejects.toThrow(/without verified human identity/)
  })

  it('retains recipient attribution when an unknown legacy relay has no primary actor', async () => {
    const f = await fixture()
    f.setState({ ...state('2'), unverifiedHistory: true })
    const scope = await f.ctx.executionAuthority.relay(f.agent.session, {
      parentSessionId: SessionId('legacy-child'), inputs: [], unverifiedHistory: true,
    }, MessageId('legacy-delivery'))
    expect(scope).toEqual({ parentSessionId: f.agent.id, inputs: [A], primaryActorUserId: 1, unverifiedHistory: true })
  })
})
