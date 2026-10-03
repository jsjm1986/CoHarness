/** Human Remote mutations bind execution after their target has been resolved. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TypertGatewayAuthorizationRequest } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { invokeTypertRemote } from '../src/api-proxy.ts'

it('binds a live write target and leaves reads, cold targets, and local calls outside a new request scope', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const session = Session.create(SessionId('live-target'))
  const agent = { id: session.id, session } as Agent
  ctx.provide('agents', { get: (id: SessionId) => id === agent.id ? agent : undefined } as never)
  const payload: TypertGatewayAuthorizationRequest = {
    endpoint: 'goals/create', namespace: 'goals', method: 'create', service: 'goals',
    args: { agentId: agent.id, objective: 'work' }, signal: new AbortController().signal,
  }
  const next = vi.fn(async () => 'result')
  expect(await invokeTypertRemote(ctx, payload, next)).toBe('result')
  const runRequest = vi.fn(async (_agent: Agent, _input: unknown, operation: () => Promise<unknown>) => {
    expect(next).toHaveBeenCalledOnce()
    return operation()
  })
  ctx.provide('executionAuthority', { runRequest } as never)
  expect(await invokeTypertRemote(ctx, payload, next)).toBe('result')
  // The operation delegate may wrap `next` (schedule/catalog scoping); the
  // returned 'result' proves it still reaches `next`.
  expect(runRequest).toHaveBeenCalledWith(agent, { endpoint: payload.endpoint, args: payload.args }, expect.any(Function))
  for (const alternate of [
    { ...payload, endpoint: 'goals/get', method: 'get' },
    { ...payload, endpoint: 'goals/pause', method: 'pause' },
    { ...payload, endpoint: 'goals/clear', method: 'clear' },
    { ...payload, endpoint: 'commands/execute', namespace: 'commands', method: 'execute' },
    { ...payload, endpoint: 'subagents/interruptByParent', namespace: 'subagents', method: 'interruptByParent', args: { parentSessionId: agent.id } },
    { ...payload, endpoint: 'host/describe', namespace: 'host', method: 'describe' },
    { ...payload, args: { agentId: 'cold-target' } },
    { ...payload, args: {} },
  ]) expect(await invokeTypertRemote(ctx, alternate, next)).toBe('result')
  expect(runRequest).toHaveBeenCalledOnce()
})

it('does not execute a managed write when its authority provider is missing', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const agent = { id: SessionId('managed-target') } as Agent
  ctx.provide('agents', { get: () => agent } as never)
  ctx.provide('executionAuthorityRequired', true)
  const next = vi.fn(async () => 'must not execute')
  expect(() => invokeTypertRemote(ctx, { endpoint: 'goals/resume', namespace: 'goals', method: 'resume', service: 'goals',
    args: { agentId: agent.id }, signal: new AbortController().signal }, next)).toThrow('requires its authorization provider')
  expect(next).not.toHaveBeenCalled()
})
