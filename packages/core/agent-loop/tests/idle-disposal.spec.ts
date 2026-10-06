/** Idle disposal refuses owned work and closes input before asynchronous teardown. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import AgentLoop from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}
const message = () => createUserMessage({ content: [{ type: 'text', text: 'pending request' }], source: { kind: 'user' } })

it('preserves parked inbox work and refuses maintenance even though its public status is idle', async () => {
  const ctx = await fixture(), handle = await ctx.agents.create({ sessionId: SessionId('idle-release') })
  const { agent } = handle
  agent.send(message(), 'next-turn', false)
  const seq = agent.session.seq
  expect(await handle.tryDisposeIdle()).toBe(false)
  expect(agent.session.seq).toBe(seq)
  expect(agent.inbox.nextTurn).toHaveLength(1)
  agent.inbox.clear()
  const finish = Promise.withResolvers<undefined>()
  let maintenanceSignal: AbortSignal | undefined
  const maintenance = agent.runMaintenance((signal) => { maintenanceSignal = signal; return finish.promise })
  expect(agent.status).toBe('idle')
  expect(await handle.tryDisposeIdle()).toBe(false)
  expect(maintenanceSignal?.aborted).toBe(false)
  finish.resolve(undefined)
  await maintenance
  const closing = handle.tryDisposeIdle()
  const closedAt = agent.session.seq
  expect(() => { agent.followup(message()) }).toThrow('input is closed')
  expect(() => agent.runMaintenance(async () => {})).toThrow('input is closed')
  expect(agent.session.seq).toBe(closedAt)
  expect(await closing).toBe(true)
  expect(ctx.agents.get(agent.id)).toBeUndefined()
  expect(ctx.sessions.get(agent.id)).toBeUndefined()
  expect(await handle.tryDisposeIdle()).toBe(true)
})

it('refuses resource owners and live children before disposing an idle parent', async () => {
  const ctx = await fixture(), parent = await ctx.agents.create({ sessionId: SessionId('parent-release') })
  const child = await ctx.agents.create({ sessionId: SessionId('child-release'), parentAgent: parent.agent })
  expect(await parent.tryDisposeIdle()).toBe(false)
  expect(ctx.agents.get(parent.agent.id) === parent.agent).toBe(true)
  await child.dispose()
  let held = true
  ctx.on('agent/idle-release-check', ({ agent }) => agent === parent.agent && held ? 'busy' : undefined, { global: true })
  expect(await parent.tryDisposeIdle()).toBe(false)
  held = false
  expect(await parent.tryDisposeIdle()).toBe(true)
})

it('fences creation and resume, and a stale reservation cannot release a later owner', async () => {
  const ctx = await fixture(), id = SessionId('reserved-removal')
  const first = ctx.agents.reserveRemoval([id])
  expect(ctx.agents.isRemoving(id)).toBe(true)
  expect(() => ctx.agents.reserveRemoval([id])).toThrow('pending lifecycle')
  await expect(ctx.agents.create({ sessionId: id })).rejects.toThrow('being removed')
  await expect(ctx.agents.resume({ resumeSessionId: id })).rejects.toThrow('being removed')
  await expect(ctx.agents.create({ sessionId: SessionId('new-child'), meta: { parentSession: id } })).rejects.toThrow('being removed')
  const prepared = ctx.sessions.prepare(id)
  expect(() => ctx.agents.enter({ id, session: prepared } as import('@deepseek-ai/dsh-agent').Agent, undefined)).toThrow('being removed')
  first[Symbol.dispose]()
  const next = ctx.agents.reserveRemoval([id])
  first[Symbol.dispose]()
  expect(ctx.agents.isRemoving(id)).toBe(true)
  next[Symbol.dispose]()
  const handle = await ctx.agents.create({ sessionId: id })
  await handle.dispose()
})

it('refuses removal while an unpublished factory operation still holds the identity', async () => {
  const ctx = await fixture(), id = SessionId('unpublished-removal')
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  const creation = ctx.agents.create({ sessionId: id, setup: async () => { entered.resolve(undefined); await finish.promise } })
  await entered.promise
  expect(() => ctx.agents.reserveRemoval([id])).toThrow('pending lifecycle')
  finish.resolve(undefined)
  const handle = await creation
  using _reservation = ctx.agents.reserveRemoval([id])
  expect(await handle.tryDisposeIdle()).toBe(true)
})

it('retains overlapping lifecycle requests until each distinct owner releases them', async () => {
  const ctx = await fixture(), id = SessionId('shared-use')
  const first = ctx.agents.reserveUse([id, id])
  const second = ctx.agents.reserveUse([id])
  first[Symbol.dispose]()
  first[Symbol.dispose]()
  expect(() => ctx.agents.reserveRemoval([id])).toThrow('pending lifecycle')
  second[Symbol.dispose]()
  using _removal = ctx.agents.reserveRemoval([id])
  expect(ctx.agents.isRemoving(id)).toBe(true)
})
