/** Real Loader and persistence keep admitted mutations ahead of permanent removal. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import Subagents from '@deepseek-ai/dsh-subagent'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { afterEach, expect, it, vi } from 'vitest'
import { hostSessionLifecycle } from '../src/session-lifecycle.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(goals = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-purge-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop], ['@deepseek-ai/dsh-subagent', Subagents],
    ['@deepseek-ai/dsh-experimental-agent-team', TeamService],
  ])
  if (goals) {
    modules.set('@deepseek-ai/dsh-goal', GoalService)
    modules.set('@deepseek-ai/dsh-goal-round-driver', GoalRoundDriver)
  }
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`Unexpected test plugin ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const entries = [...modules.keys()].map(name => ({ name,
    ...name === '@deepseek-ai/dsh-session-persistence-jsonl' ? { config: { root: join(directory, 'sessions'), compression: 'none' } }
      : name === '@deepseek-ai/dsh-agent-loop' ? { config: { agents: [] } } : {},
  }))
  const file = join(directory, 'cordis.yml')
  await writeFile(file, JSON.stringify(entries))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  const handle = await ctx.agents.create({ sessionId: SessionId('purge-root'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  const owner = hostSessionLifecycle(ctx)
  owner.own(handle)
  return { ctx, handle, owner }
}

it.each(['success', 'failure'] as const)('holds an admitted Team mutation through its real checkpoint, then permits purge (%s)', async (outcome) => {
  const { ctx, handle, owner } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const stop = ctx.on('session/flush', async (session) => {
    if (session !== handle.agent.session) return
    entered.resolve(undefined)
    await release.promise
    if (outcome === 'failure') throw new Error('fixture checkpoint failed')
  })
  const operation = ctx.agentTeams.remoteCreateTask(handle.agent, { subject: 'in-flight task', description: 'pending checkpoint' })
  const settled = operation.then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  const remove = vi.fn(async () => { await ctx.sessionPersistence.remove(handle.agent.id); return 'removed' })
  try {
    expect(handle.agent.status).toBe('idle')
    await expect(owner.withReleased([handle.agent.id], remove)).rejects.toThrow('pending lifecycle operation')
    expect(remove).not.toHaveBeenCalled()
    expect(ctx.agents.get(handle.agent.id) === handle.agent).toBe(true)
  } finally { release.resolve(undefined) }
  const result = await settled
  stop()
  if (outcome === 'success') expect(result).toMatchObject({ value: { ok: true, value: { subject: 'in-flight task' } } })
  else expect(result).toEqual({ error: new Error('fixture checkpoint failed') })
  expect(await ctx.sessionPersistence.stat(handle.agent.id)).toBeDefined()
  expect(await owner.withReleased([handle.agent.id], remove)).toBe('removed')
  expect(remove).toHaveBeenCalledOnce()
  expect(await ctx.sessionPersistence.stat(handle.agent.id)).toBeUndefined()
})

it('rejects a new Team mutation while its Session is reserved for removal without appending an event', async () => {
  const { ctx, handle } = await fixture()
  const before = handle.agent.session.seq
  {
    using _reservation = ctx.agents.reserveRemoval([handle.agent.id])
    await expect(ctx.agentTeams.remoteCreateTask(handle.agent, { subject: 'late task', description: 'must not start' }))
      .rejects.toThrow('being removed')
  }
  expect(handle.agent.session.seq).toBe(before)
  expect(ctx.agentTeams.listTasks(handle.agent)).toEqual([])
  expect(await ctx.agentTeams.remoteCreateTask(handle.agent, { subject: 'admitted task', description: 'after reservation' }))
    .toMatchObject({ ok: true })
})

it.each(['pause', 'failure'] as const)('retains Goal data during its checkpoint and releases its reservation after %s', async (outcome) => {
  const { ctx, handle, owner } = await fixture(true)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const paused = Promise.withResolvers<undefined>(), releasePause = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined); releasePause.resolve(undefined) })
  let flushes = 0
  const stop = ctx.on('session/flush', async (session) => {
    if (session !== handle.agent.session) return
    if (flushes++ === 0) {
      entered.resolve(undefined)
      await release.promise
    } else {
      paused.resolve(undefined)
      await releasePause.promise
    }
    if (outcome === 'failure') throw new Error('fixture Goal checkpoint failed')
  })
  const goal = ctx.goals.create(handle.agent, { objective: 'retain pending Goal work' })
  await entered.promise
  const remove = vi.fn(async () => { await ctx.sessionPersistence.remove(handle.agent.id); return 'removed' })
  try {
    expect(handle.agent.status).toBe('idle')
    expect(ctx.goals.get(handle.agent)).toMatchObject({ activation: 'armed', roundsStarted: 0 })
    await expect(owner.withReleased([handle.agent.id], remove)).rejects.toThrow('pending lifecycle operation')
    expect(remove).not.toHaveBeenCalled()
    expect(ctx.agents.get(handle.agent.id) === handle.agent).toBe(true)
    if (outcome === 'pause') ctx.goals.pause(handle.agent, goal)
  } finally { release.resolve(undefined) }
  if (outcome === 'pause') {
    await paused.promise
    try {
      await expect(owner.withReleased([handle.agent.id], remove)).rejects.toThrow('pending lifecycle operation')
      expect(remove).not.toHaveBeenCalled()
    } finally { releasePause.resolve(undefined) }
  }
  await vi.waitFor(() => { using _reservation = ctx.agents.reserveRemoval([handle.agent.id]) })
  stop()
  expect(ctx.goals.get(handle.agent)).toMatchObject({
    phase: outcome === 'pause' ? 'paused' : 'active', activation: 'disarmed', roundsStarted: 0,
  })
  expect(await ctx.sessionPersistence.stat(handle.agent.id)).toBeDefined()
  expect(await owner.withReleased([handle.agent.id], remove)).toBe('removed')
  expect(remove).toHaveBeenCalledOnce()
  expect(await ctx.sessionPersistence.stat(handle.agent.id)).toBeUndefined()
})

it('hands checkpoint ownership to a live Goal turn and allows purge after explicit pause', async () => {
  const { ctx, handle, owner } = await fixture(true)
  const requested = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined) })
  class ControlledAdapter extends LlmAdapter {
    override async * stream(): AsyncIterable<StreamChunk> {
      requested.resolve(undefined)
      await release.promise
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture response' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new ControlledAdapter())
  const goal = ctx.goals.create(handle.agent, { objective: 'work until explicitly paused' })
  await requested.promise
  await vi.waitFor(() => { using _reservation = ctx.agents.reserveRemoval([handle.agent.id]) })
  const remove = vi.fn(async () => { await ctx.sessionPersistence.remove(handle.agent.id); return 'removed' })
  try {
    expect(handle.agent.status).toBe('running')
    expect(ctx.goals.get(handle.agent)).toMatchObject({ roundsStarted: 1 })
    await expect(owner.withReleased([handle.agent.id], remove)).rejects.toThrow('active work')
    expect(remove).not.toHaveBeenCalled()
    ctx.goals.pause(handle.agent, goal)
  } finally { release.resolve(undefined) }
  await handle.agent.whenIdle()
  await vi.waitFor(() => { using _reservation = ctx.agents.reserveRemoval([handle.agent.id]) })
  expect(ctx.goals.get(handle.agent)).toMatchObject({ phase: 'paused', roundsStarted: 1 })
  expect(await ctx.sessionPersistence.stat(handle.agent.id)).toBeDefined()
  expect(await owner.withReleased([handle.agent.id], remove)).toBe('removed')
  expect(remove).toHaveBeenCalledOnce()
})
