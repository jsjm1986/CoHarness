/** SDK approvals use the real bidirectional wire and the internal audit service. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

async function setup(enabled?: boolean, subagents = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  if (subagents) await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 2 }, () => textResponse('done'))))
  const input = new PassThrough()
  const output = new PassThrough()
  const serverWire = new JsonRpcLineTransport(input, output)
  const client = new JsonRpcLineTransport(output, input)
  const server = new HarnessSdkJsonRpcServer(ctx, serverWire)
  onTestFinished(async () => {
    await server.shutdown()
    serverWire.close()
    client.close()
    input.destroy()
    output.destroy()
  })
  serverWire.onRequest((method, params) => server.handleRequest(method, params))
  serverWire.start()
  client.start()
  await client.request('initialize', {
    cwd: process.cwd(), provider: 'mock', model: 'mock',
    ...(enabled === undefined ? {} : { approvalRequests: enabled }),
  })
  await client.request('session/working-directory/get', { sessionId: 'main' })
  const agent = ctx.agents.get(SessionId('main'))!
  agent.session.append('turn/start', { turn: 1 })
  return { ctx, server, serverWire, client, agent, input }
}

describe('SDK approval bridge', () => {
  it.each(['allowed-once', 'rejected', 'cancelled'] as const)('applies and audits %s', async (outcome) => {
    const h = await setup(true)
    h.client.onRequest(async (method, params) => {
      expect(method).toBe('approval/request')
      expect(params).toEqual({ sessionId: 'main', toolName: 'bash', callId: 'call-1', reason: 'write outside workspace' })
      return { outcome }
    })
    await expect(h.ctx.approval.request({
      agent: h.agent, toolName: 'bash', callId: ToolCallId('call-1'), reason: 'write outside workspace',
    })).resolves.toBe(outcome)
    expect(h.agent.session.snapshotEvents().slice(-2).map(e => [e.type, e.data])).toEqual([
      ['approval/asked', expect.objectContaining({ toolName: 'bash', reason: 'write outside workspace' })],
      ['approval/decided', expect.objectContaining({ outcome })],
    ])
  })

  it.each([undefined, false])('delegates when approvalRequests is %s', async (enabled) => {
    const h = await setup(enabled)
    h.ctx.on('approval/request', () => Promise.resolve('rejected'))
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'bash' })).resolves.toBe('rejected')
  })

  it.each([null, {}, { outcome: 'allow-always' }, { outcome: true }])('fails closed for invalid response %j', async (result) => {
    const h = await setup(true)
    h.client.onRequest(() => Promise.resolve(result))
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'bash' })).resolves.toBe('unavailable')
  })

  it('fails closed on client errors and a disconnected transport', async () => {
    const h = await setup(true)
    h.client.onRequest(() => Promise.reject(new Error('no decision')))
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'bash' })).resolves.toBe('unavailable')
    h.serverWire.close()
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'bash' })).resolves.toBe('unavailable')
  })

  it('correlates concurrent requests while another client request is in flight', async () => {
    const h = await setup(true)
    const first = Promise.withResolvers<object>()
    const entered = Promise.withResolvers<undefined>()
    h.client.onRequest(async (_method, params) => {
      if (params.toolName === 'first') {
        entered.resolve(undefined)
        return first.promise
      }
      return { outcome: 'rejected' }
    })
    onTestFinished(() => { first.resolve({ outcome: 'cancelled' }) })
    const pending = h.ctx.approval.request({ agent: h.agent, toolName: 'first' })
    await entered.promise
    await expect(h.ctx.approval.request({ agent: h.agent, toolName: 'second' })).resolves.toBe('rejected')
    await expect(h.client.request('session/working-directory/get', { sessionId: 'main' })).resolves.toHaveProperty('cwd')
    first.resolve({ outcome: 'allowed-once' })
    await expect(pending).resolves.toBe('allowed-once')
  })

  it.each(['cancel', 'shutdown', 'disconnect'] as const)('settles a pending approval on %s and ignores a late grant', async (action) => {
    const h = await setup(true)
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<object>()
    h.client.onRequest(() => { entered.resolve(undefined); return answer.promise })
    onTestFinished(() => { answer.resolve({ outcome: 'cancelled' }) })
    const cancellation = new AbortController()
    const pending = h.ctx.approval.request({ agent: h.agent, toolName: 'bash', signal: cancellation.signal })
    await entered.promise
    if (action === 'cancel') cancellation.abort()
    else if (action === 'shutdown') await h.server.shutdown()
    else h.serverWire.close()
    await expect(pending).resolves.toBe(action === 'cancel' ? 'cancelled' : 'unavailable')
    const delivered = Promise.withResolvers<Buffer>()
    h.input.once('data', delivered.resolve)
    onTestFinished(() => { h.input.off('data', delivered.resolve) })
    answer.resolve({ outcome: 'allowed-once' })
    expect(JSON.parse(String(await delivered.promise))).toMatchObject({ result: { outcome: 'allowed-once' } })
    expect(h.agent.session.snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome))
      .toEqual([action === 'cancel' ? 'cancelled' : 'unavailable'])
  })

  // Ownership is the durable subagent lineage: only a live chain of
  // `origin: 'subagent'` sessions ending at an SDK-owned root is served, and no
  // separate runtime registry contradicts the logged parent.
  it.each([false, true])(
    'claims an unrelated live Agent only by SDK session lineage (subagents runtime=%s)',
    async (subagents) => {
      const h = await setup(true, subagents)
      const foreign = await h.ctx.agents.create({
        sessionId: SessionId('foreign'),
        meta: { cwd: process.cwd() },
      })
      onTestFinished(() => foreign.dispose())
      foreign.agent.session.append('turn/start', { turn: 1 })
      const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
      h.client.onRequest(clientDecision)
      h.ctx.on('approval/request', () => Promise.resolve('rejected'))
      await expect(h.ctx.approval.request({ agent: foreign.agent, toolName: 'bash' })).resolves.toBe('rejected')
      expect(clientDecision).not.toHaveBeenCalled()
    },
  )

  it('claims an Agent whose durable lineage descends from an SDK session', async () => {
    const h = await setup(true)
    const child = await h.ctx.agents.create({
      sessionId: SessionId('child'),
      meta: { cwd: process.cwd(), parentSession: h.agent.session.id, origin: 'subagent' },
    })
    onTestFinished(() => child.dispose())
    child.agent.session.append('turn/start', { turn: 1 })
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    h.ctx.on('approval/request', () => Promise.resolve('rejected'))
    await expect(h.ctx.approval.request({ agent: child.agent, toolName: 'bash' })).resolves.toBe('allowed-once')
    expect(clientDecision).toHaveBeenLastCalledWith('approval/request', { sessionId: 'child', toolName: 'bash' })
  })

  it.each([false, true])('serves descendants by durable SDK session lineage: %s and preserves never policy', async (hasLineage) => {
    const h = await setup(true, true)
    const child = await h.ctx.agents.create({
      sessionId: SessionId('child'),
      meta: {
        cwd: process.cwd(),
        ...(hasLineage ? { parentSession: h.agent.session.id, origin: 'subagent' as const } : {}),
      },
    })
    onTestFinished(() => child.dispose())
    const grandchild = await h.ctx.agents.create({
      sessionId: SessionId('grandchild'),
      meta: { cwd: process.cwd(), parentSession: child.agent.session.id, origin: 'subagent' },
    })
    onTestFinished(() => grandchild.dispose())
    child.agent.session.append('turn/start', { turn: 1 })
    grandchild.agent.session.append('turn/start', { turn: 1 })
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    h.ctx.on('approval/request', () => Promise.resolve('rejected'))
    if (!hasLineage) {
      for (const agent of [child.agent, grandchild.agent]) {
        await expect(h.ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('rejected')
      }
      expect(clientDecision).not.toHaveBeenCalled()
      return
    }
    for (const agent of [child.agent, grandchild.agent]) {
      await expect(h.ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('allowed-once')
      expect(clientDecision).toHaveBeenLastCalledWith('approval/request', { sessionId: agent.session.id, toolName: 'bash' })
    }
    h.ctx.approval.setPolicy(child.agent, 'never')
    await expect(h.ctx.approval.request({ agent: child.agent, toolName: 'bash' })).resolves.toBe('rejected')
    expect(clientDecision).toHaveBeenCalledTimes(2)
  })

  // Upstream keeps routing through a runtime-stored ancestor list after the
  // intermediate Agent leaves; this server's durable parent chain resolves only
  // through live Agents, so a disposed link ends the delegation tree.
  it('delegates a descendant approval once an intermediate ancestor leaves', async () => {
    const h = await setup(true, true)
    const child = await h.ctx.agents.create({
      sessionId: SessionId('child'),
      meta: { cwd: process.cwd(), parentSession: h.agent.session.id, origin: 'subagent' },
    })
    const grandchild = await h.ctx.agents.create({
      sessionId: SessionId('grandchild'),
      meta: { cwd: process.cwd(), parentSession: child.agent.session.id, origin: 'subagent' },
    })
    onTestFinished(() => grandchild.dispose())
    grandchild.agent.session.append('turn/start', { turn: 1 })
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    h.ctx.on('approval/request', () => Promise.resolve('rejected'))
    await expect(h.ctx.approval.request({ agent: grandchild.agent, toolName: 'bash' })).resolves.toBe('allowed-once')
    expect(clientDecision).toHaveBeenLastCalledWith('approval/request', { sessionId: 'grandchild', toolName: 'bash' })
    await child.dispose()
    await expect(h.ctx.approval.request({ agent: grandchild.agent, toolName: 'bash' })).resolves.toBe('rejected')
    expect(clientDecision).toHaveBeenCalledTimes(1)
  })

  it('does not claim a disposed Agent when an owned replacement reuses its id', async () => {
    const h = await setup(true, true)
    const old = await h.ctx.agents.create({
      sessionId: SessionId('reused'),
      meta: { cwd: process.cwd(), parentSession: h.agent.session.id, origin: 'subagent' },
    })
    await old.dispose()
    const replacement = await h.ctx.agents.create({
      sessionId: old.agent.id,
      meta: { cwd: process.cwd(), parentSession: h.agent.session.id, origin: 'subagent' },
    })
    onTestFinished(() => replacement.dispose())
    const clientDecision = vi.fn(async () => ({ outcome: 'allowed-once' }))
    h.client.onRequest(clientDecision)
    // Dispatch at the answerer seam: disposal has already closed the old Agent's turn.
    await expect(h.ctx.waterfall('approval/request', { agent: old.agent, toolName: 'bash' },
      () => Promise.resolve('rejected' as const))).resolves.toBe('rejected')
    expect(clientDecision).not.toHaveBeenCalled()
  })

  it('rejects an invalid wire capability flag', async () => {
    const h = await setup()
    await expect(h.client.request('initialize', { cwd: '.', provider: 'mock', model: 'mock', approvalRequests: 'true' }))
      .rejects.toThrow('approvalRequests must be a boolean')
  })
})
