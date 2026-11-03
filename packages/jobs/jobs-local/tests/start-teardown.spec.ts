/** Pending producer registration remains owned through reentrant teardown. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '../src/index.ts'
import { expect, it, onTestFinished } from 'vitest'

/** Producer-owned namespace used only by these job lifecycle fixtures. */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    fixture: 'fixture'
  }
}

it.each([
  { scope: 'service', owned: false }, { scope: 'service', owned: true }, { scope: 'owner', owned: true },
] as const)('joins a pending registration when $scope exits with owned=$owned', async ({ scope, owned }) => {
  const ctx = new Context(), done = Promise.withResolvers<JobOutcome>()
  let withdrawal: Promise<void> | undefined
  onTestFinished(async () => {
    done.resolve({ status: 'killed' })
    await withdrawal
    await ctx.fiber.dispose()
  })
  await ctx.plugin(AgentRegistry)
  const service = ctx.plugin(LocalJobRegistry)
  await service.await()
  const jobs = ctx.jobs
  jobs.attachController('pending-start-test')
  const ownerId = SessionId('pending-job-owner')
  const owner = owned
    ? { id: ownerId, ctx: ctx.plugin(() => {}).ctx, options: {}, session: Session.create(ownerId) } as unknown as Agent
    : undefined
  if (owner !== undefined) await ctx.agents.register(owner)
  let cancels = 0, live = true
  const id = jobs.start({ kind: 'fixture', label: 'pending producer', ...owned ? { owner: ownerId } : {},
    run: () => {
      withdrawal = scope === 'service' ? service.dispose() : owner!.ctx.fiber.dispose()
      return { cancel: () => { cancels++; live = false; done.resolve({ status: 'killed' }) }, done: done.promise }
    } })
  await withdrawal
  expect({ cancels, live, remaining: jobs.list(owner?.id).map(job => job.id) })
    .toEqual({ cancels: 1, live: false, remaining: [] })
  expect(() => jobs.get(id, owner?.id)).toThrow('unknown job')
})

it('reserves exact-owner capacity before invoking execution-authority capture', async () => {
  const ctx = new Context(), settled = Promise.withResolvers<JobOutcome>()
  onTestFinished(async () => { settled.resolve({ status: 'killed' }); await ctx.fiber.dispose() })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 1 })
  ctx.jobs.attachController('capture-admission-test')
  const ownerId = SessionId('capture-job-owner')
  const owner = { id: ownerId, ctx: ctx.plugin(() => {}).ctx, options: {}, session: Session.create(ownerId) } as unknown as Agent
  await ctx.agents.register(owner)
  let capturing = false, starts = 0, refused: unknown
  const spec: JobSpec = { owner: ownerId, kind: 'fixture', label: 'capture owner', run: () => {
    starts++
    return { cancel: () => { settled.resolve({ status: 'killed' }) }, done: settled.promise }
  } }
  // The registry consumes only this external provider's synchronous authority capture.
  ctx.provide('executionAuthority', { capture: () => {
    if (!capturing) {
      capturing = true
      try { ctx.jobs.start(spec) } catch (error) { refused = error }
    }
    return { parentSessionId: ownerId, inputs: [], unverifiedHistory: true }
  } } as never)
  const id = ctx.jobs.start(spec)
  if (!(refused instanceof Error)) throw new Error('Nested job was not refused during execution capture')
  expect(refused.message).toContain('(limit: 1)')
  expect(starts).toBe(1)
  expect(ctx.jobs.list(ownerId).map(job => job.id)).toEqual([id])
})

it('releases reserved capacity when execution-authority capture refuses the start', async () => {
  const ctx = new Context(), settled = Promise.withResolvers<JobOutcome>()
  onTestFinished(async () => { settled.resolve({ status: 'killed' }); await ctx.fiber.dispose() })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 1 })
  ctx.jobs.attachController('capture-failure-test')
  const id = SessionId('capture-failure-owner')
  const owner = { id, ctx: ctx.plugin(() => {}).ctx, options: {}, session: Session.create(id) } as unknown as Agent
  await ctx.agents.register(owner)
  let refuse = true, starts = 0
  const failure = new Error('execution-authority unavailable')
  ctx.provide('executionAuthority', { capture: () => {
    if (refuse) throw failure
    return { parentSessionId: id, inputs: [], unverifiedHistory: true }
  } } as never)
  const spec: JobSpec = { owner: id, kind: 'fixture', label: 'capture refusal', run: () => {
    starts++
    return { cancel: () => { settled.resolve({ status: 'killed' }) }, done: settled.promise }
  } }
  expect(() => ctx.jobs.start(spec)).toThrow(failure)
  expect(starts).toBe(0)
  expect(ctx.jobs.list(id)).toEqual([])
  refuse = false
  const accepted = ctx.jobs.start(spec)
  expect(starts).toBe(1)
  expect(ctx.jobs.get(accepted, id).status).toBe('running')
})

it('keeps another exact owner available while authority capture holds a capacity slot', async () => {
  const ctx = new Context(), settled = Promise.withResolvers<JobOutcome>()
  onTestFinished(async () => { settled.resolve({ status: 'killed' }); await ctx.fiber.dispose() })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 1 })
  ctx.jobs.attachController('capture-isolation-test')
  const owners: Agent[] = []
  for (const name of ['capture-first-owner', 'capture-second-owner']) {
    const id = SessionId(name)
    const owner = { id, ctx: ctx.plugin(() => {}).ctx, options: {}, session: Session.create(id) } as unknown as Agent
    owners.push(owner)
    await ctx.agents.register(owner)
  }
  let capturing = false, starts = 0
  const spec = (owner: Agent): JobSpec => ({ owner: owner.id, kind: 'fixture', label: 'independent owner', run: () => {
    starts++
    return { cancel: () => { settled.resolve({ status: 'killed' }) }, done: settled.promise }
  } })
  const [first, second] = owners as [Agent, Agent]
  ctx.provide('executionAuthority', { capture: (owner: Agent) => {
    if (!capturing) { capturing = true; ctx.jobs.start(spec(second)) }
    return { parentSessionId: owner.id, inputs: [], unverifiedHistory: true }
  } } as never)
  ctx.jobs.start(spec(first))
  expect(starts).toBe(2)
  expect(ctx.jobs.list(first.id)).toHaveLength(1)
  expect(ctx.jobs.list(second.id)).toHaveLength(1)
})
