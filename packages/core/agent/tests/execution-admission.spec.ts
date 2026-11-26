/** Restored identities refuse factories and publication before any execution side effects. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { AgentExecutionRestrictedError, installAgentExecutionAdmission } from '@deepseek-ai/dsh-agent'
import { expect, it, onTestFinished, vi } from 'vitest'

it('blocks historical identities and parents before factories while leaving fresh identities available', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const old = SessionId('restored-old'), fresh = SessionId('fresh-new')
  const ids = [old]
  installAgentExecutionAdmission(ctx, ids)
  ids.push(fresh)
  await ctx.plugin(AgentRegistry)
  const reached = new Error('fresh factory reached')
  const factory = { createAgent: vi.fn(async () => { throw reached }), resume: vi.fn(async () => { throw reached }) }
  ctx.agents.setFactory(factory)
  expect(() => ctx.agents.reserveUse([old])).toThrow(AgentExecutionRestrictedError)
  await expect(ctx.agents.create({ sessionId: old })).rejects.toMatchObject({ code: 'recovery-read-only', sessionId: old })
  await expect(ctx.agents.resume({ resumeSessionId: old })).rejects.toMatchObject({ code: 'recovery-read-only' })
  await expect(ctx.agents.create({ sessionId: fresh, meta: { parentSession: old } })).rejects.toMatchObject({ code: 'recovery-read-only' })
  expect(factory.createAgent).not.toHaveBeenCalled()
  expect(factory.resume).not.toHaveBeenCalled()
  await expect(ctx.agents.create({ sessionId: fresh })).rejects.toBe(reached)
  expect(factory.createAgent).toHaveBeenCalledTimes(1)
  expect(ctx.agentExecutionAdmission.restriction(old)?.code).toBe('recovery-read-only')
  expect(ctx.agentExecutionAdmission.restriction(fresh)).toBeUndefined()
})
