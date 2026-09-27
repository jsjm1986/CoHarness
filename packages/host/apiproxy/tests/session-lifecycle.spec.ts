/** The Host disposes only handles it owns, before invoking persistent removal. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { hostSessionLifecycle } from '../src/session-lifecycle.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, owner: hostSessionLifecycle(ctx) }
}

it('requires the actual creator handle and keeps data while a resource blocks idle release', async () => {
  const { ctx, owner } = await fixture(), id = SessionId('owned-release')
  const handle = await ctx.agents.create({ sessionId: id })
  const remove = vi.fn(async () => 'removed')
  await expect(owner.withReleased([id], remove)).rejects.toThrow('another lifecycle owner')
  expect(remove).not.toHaveBeenCalled()
  expect(hostSessionLifecycle(ctx).own(handle) === handle.agent).toBe(true)
  let held = true
  ctx.on('agent/idle-release-check', () => held ? 'busy' : undefined, { global: true })
  await expect(owner.withReleased([id], remove)).rejects.toThrow('active work')
  expect(ctx.agents.get(id) === handle.agent).toBe(true)
  expect(remove).not.toHaveBeenCalled()
  held = false
  expect(await owner.withReleased([id], async () => {
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    await expect(ctx.agents.create({ sessionId: id })).rejects.toThrow('being removed')
    return remove()
  })).toBe('removed')
  expect(remove).toHaveBeenCalledOnce()
  expect(ctx.agents.isRemoving(id)).toBe(false)
  expect(() => owner.own(handle)).toThrow('owner changed')
})

it('keeps the reservation through storage failure and allows a later retry', async () => {
  const { ctx, owner } = await fixture(), id = SessionId('cold-release')
  const remove = vi.fn(async () => {
    expect(ctx.agents.isRemoving(id)).toBe(true)
    throw new Error('fixture storage unavailable')
  })
  await expect(owner.withReleased([id], remove)).rejects.toThrow('fixture storage unavailable')
  expect(ctx.agents.isRemoving(id)).toBe(false)
  expect(await owner.withReleased([id], async () => 'retry completed')).toBe('retry completed')
})

it('refuses deletion after a disposer error even if that Agent was detached', async () => {
  const { ctx, owner } = await fixture(), id = SessionId('failed-release')
  const handle = await ctx.agents.create({ sessionId: id })
  const release = handle.tryDisposeIdle.bind(handle)
  owner.own({ ...handle, tryDisposeIdle: async () => { await release(); throw new Error('fixture flush failed') } })
  const remove = vi.fn(async () => {})
  await expect(owner.withReleased([id], remove)).rejects.toThrow('durable archive data was retained')
  expect(remove).not.toHaveBeenCalled()
  expect(ctx.agents.isRemoving(id)).toBe(false)
})

it('refuses a disposer that reports success while its Session remains loaded', async () => {
  const { ctx, owner } = await fixture(), id = SessionId('incomplete-release')
  const handle = await ctx.agents.create({ sessionId: id })
  owner.own({ ...handle, tryDisposeIdle: async () => true })
  const remove = vi.fn(async () => {})
  await expect(owner.withReleased([id], remove)).rejects.toThrow('release has not completed')
  expect(remove).not.toHaveBeenCalled()
  expect(ctx.sessions.get(id)).toBe(handle.agent.session)
})

it('keeps the new owner after a delayed disposal notification from an earlier incarnation', async () => {
  const { ctx, owner } = await fixture(), id = SessionId('reused-release')
  const old = await ctx.agents.create({ sessionId: id })
  owner.own(old)
  await old.dispose()
  const current = await ctx.agents.create({ sessionId: id })
  owner.own(current)
  await ctx.parallel(agentCarrier(old.agent), 'agent/disposed', { agent: old.agent })
  expect(await owner.withReleased([id], async () => 'removed')).toBe('removed')
})

it.each(['parent-first', 'child-first'] as const)('releases a completely idle owned tree before removal on its first attempt (%s)', async (order) => {
  const { ctx, owner } = await fixture()
  const parent = await ctx.agents.create({ sessionId: SessionId('tree-parent') })
  const child = await ctx.agents.create({ sessionId: SessionId('tree-child'), parentAgent: parent.agent })
  const grandchild = await ctx.agents.create({ sessionId: SessionId('tree-grandchild'), parentAgent: child.agent })
  const handles = [parent, child, grandchild]
  for (const handle of handles) owner.own(handle)
  const ids = (order === 'parent-first' ? handles : [grandchild, parent, child]).map(handle => handle.agent.id)
  const disposed: string[] = []
  ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id) }, { global: true })
  const remove = vi.fn(async () => {
    expect(disposed).toEqual([grandchild.agent.id, child.agent.id, parent.agent.id])
    for (const id of ids) {
      expect(ctx.agents.get(id)).toBeUndefined()
      expect(ctx.sessions.get(id)).toBeUndefined()
      expect(ctx.agents.isRemoving(id)).toBe(true)
    }
    return 'removed'
  })
  expect(await owner.withReleased(ids, remove)).toBe('removed')
  expect(remove).toHaveBeenCalledOnce()
})

it('retains persistent data and the parent when its child has pending work', async () => {
  const { ctx, owner } = await fixture()
  const parent = await ctx.agents.create({ sessionId: SessionId('busy-tree-parent') })
  const child = await ctx.agents.create({ sessionId: SessionId('busy-tree-child'), parentAgent: parent.agent })
  owner.own(parent); owner.own(child)
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'pending child work' }] })
  child.agent.send(message, 'next-turn', false)
  const remove = vi.fn(async () => 'must not remove')
  await expect(owner.withReleased([parent.agent.id, child.agent.id], remove)).rejects.toThrow('active work')
  expect(remove).not.toHaveBeenCalled()
  expect(ctx.agents.get(parent.agent.id) === parent.agent).toBe(true)
  expect(ctx.agents.get(child.agent.id) === child.agent).toBe(true)
  expect(child.agent.inbox.nextTurn).toEqual([message])
  expect(ctx.agents.isRemoving(child.agent.id)).toBe(false)
})
