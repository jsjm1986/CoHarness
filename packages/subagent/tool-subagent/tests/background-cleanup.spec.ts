/** Background child completion waits for confirmed provider cleanup. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentCarrier } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '../src/index.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

it.each(['completed', 'rejected', 'unrenderable'] as const)(
  'retains the background job and retries cleanup for %s',
  async (mode) => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs, {})
    let allowCleanup = false, resourceLive = true, attempts = 0
    const dispose = (): Promise<void> => {
      attempts += 1
      if (!allowCleanup) throw mode === 'unrenderable' ? Object.create(null) : new Error('child transport still active')
      resourceLive = false
      return Promise.resolve()
    }
    ctx.subagents.registerProvider({
      name: 'cleanup-child', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: () => Promise.resolve({
        id: SessionId('owned-cleanup-child'), localAgent: undefined,
        result: mode === 'rejected'
          ? Promise.reject(new Error('child result unavailable'))
          : Promise.resolve({ output: [{ type: 'text', text: 'unconfirmed child answer' }], stopReason: 'completed' as const }),
        dispose,
      }),
    })
    await ctx.plugin(tool, { provider: 'cleanup-child', backgroundMode: 'one-shot', maxDepth: 'provider-managed' })
    const parent = {
      id: SessionId('cleanup-owner'), ctx: ctx.plugin(() => {}).ctx, options: {},
      session: Session.create(SessionId('cleanup-owner')),
    } as unknown as Agent
    ctx.agents.register(parent)
    const observed = Promise.withResolvers<undefined>()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => { observed.resolve(undefined) })
    ctx.jobs.events.subscribe({ owner: parent.id }, (event) => {
      if (event.type === 'settled') observed.resolve(undefined)
    })
    const accepted = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('child-cleanup'), name: 'subagent',
      arguments: { description: 'retained child', prompt: 'work', run_in_background: true }, agent: parent,
    })
    expect(accepted.isError, JSON.stringify(accepted)).toBe(false)
    const { jobId } = accepted.value as { jobId: JobId }
    try {
      await observed.promise
      expect(ctx.jobs.get(jobId, parent.id).status).toBe('running')
      expect(ctx.jobs.get(jobId, parent.id).progress).toContain('cleanup is unconfirmed')
      expect(resourceLive).toBe(true)
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBe('busy')
      expect(parent.session.snapshotEvents().filter(event => event.type === 'job/settled')).toEqual([])
      expect(warn).toHaveBeenCalled()
      allowCleanup = true
      expect(ctx.jobs.kill(jobId, parent.id, 'retry cleanup')).toBe('requested')
      const settled = await ctx.jobs.wait(jobId, 5_000, parent.id)
      expect(settled.status).toBe('failed')
      expect(settled.detail).toContain('dispose failed:')
      if (mode === 'rejected') expect(settled.detail).toContain('child result unavailable')
      expect(settled.detail).not.toContain('unconfirmed child answer')
      expect(resourceLive).toBe(false)
      expect(attempts).toBe(2)
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBeUndefined()
      expect(parent.session.snapshotEvents().filter(event => event.type === 'job/settled')).toHaveLength(1)
    } finally {
      allowCleanup = true
      ctx.jobs.kill(jobId, parent.id, 'test cleanup')
      await ctx.jobs.wait(jobId, 5_000, parent.id)
      await dispose()
    }
  },
)

it.each(['job kill', 'parent exit', 'service exit', 'repeat cleanup failure', 'repeated pending kills'] as const)(
  'retains a cleanup retry requested during pending disposal by %s', async (mode) => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentRegistry)
    const jobsFiber = ctx.plugin(LocalJobRegistry)
    await jobsFiber
    const jobs = ctx.jobs
    await ctx.plugin(ToolJobs, {})
    const cleanupEntered = Promise.withResolvers<undefined>(), firstDisposal = Promise.withResolvers<undefined>()
    const cleanupObserved = Promise.withResolvers<undefined>(), repeatObserved = Promise.withResolvers<undefined>()
    let resourceLive = true, attempts = 0
    ctx.subagents.registerProvider({
      name: 'pending-cleanup-child', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: () => Promise.resolve({
        id: SessionId('pending-cleanup-child'), localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'child answer' }], stopReason: 'completed' as const }),
        dispose: async () => {
          attempts++
          if (attempts === 1) { cleanupEntered.resolve(undefined); await firstDisposal.promise; throw new Error('first provider cleanup failed') }
          if (mode === 'repeat cleanup failure' && attempts === 2) throw new Error('second provider cleanup failed')
          resourceLive = false
        },
      }),
    })
    await ctx.plugin(tool, { provider: 'pending-cleanup-child', backgroundMode: 'one-shot', maxDepth: 'provider-managed' })
    const parent = { id: SessionId('pending-cleanup-owner'), ctx: ctx.plugin(() => {}).ctx, options: {},
      session: Session.create(SessionId('pending-cleanup-owner')) } as unknown as Agent
    ctx.agents.register(parent)
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => { cleanupObserved.resolve(undefined); if (attempts === 2) repeatObserved.resolve(undefined) })
    const accepted = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('pending-child-cleanup'),
      name: 'subagent', arguments: { description: 'pending child', prompt: 'work', run_in_background: true }, agent: parent })
    expect(accepted.isError, JSON.stringify(accepted)).toBe(false)
    const { jobId } = accepted.value as { jobId: JobId }
    let parentDisposal: Promise<void> | undefined
    try {
      await cleanupEntered.promise
      if (mode !== 'parent exit' && mode !== 'service exit') {
        expect(jobs.kill(jobId, parent.id, 'stop during cleanup')).toBe('requested')
        if (mode === 'repeated pending kills') {
          expect(jobs.kill(jobId, parent.id, 'coalesced stop')).toBe('requested')
          expect(jobs.kill(jobId, parent.id, 'coalesced stop')).toBe('requested')
        }
      }
      else {
        parentDisposal = Promise.resolve(mode === 'parent exit' ? parent.ctx.fiber.dispose() : jobsFiber.dispose())
        await expect.poll(() => jobs.get(jobId, parent.id).status).toBe('stopping')
      }
      expect(resourceLive).toBe(true)
      firstDisposal.resolve(undefined)
      await cleanupObserved.promise
      if (mode === 'repeat cleanup failure') {
        await repeatObserved.promise
        const retained = jobs.get(jobId, parent.id)
        expect(retained.status).toBe('stopping')
        expect(attempts).toBe(2)
        expect(resourceLive).toBe(true)
        expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBe('busy')
        expect(parent.session.snapshotEvents().filter(event => event.type === 'job/settled')).toHaveLength(0)
        expect(jobs.kill(jobId, parent.id, 'retry continuing cleanup failure')).toBe('requested')
      }
      await expect.poll(() => resourceLive, { timeout: 1_000 }).toBe(false)
      expect(attempts).toBe(mode === 'repeat cleanup failure' ? 3 : 2)
      if (parentDisposal !== undefined) await parentDisposal
      else {
        const settled = await jobs.wait(jobId, 1_000, parent.id)
        expect(settled.status).toBe('failed')
        expect(settled.detail).toContain(mode === 'repeat cleanup failure' ? 'second provider cleanup failed' : 'first provider cleanup failed')
      }
    } finally {
      firstDisposal.resolve(undefined)
      if (resourceLive) {
        jobs.kill(jobId, parent.id, 'test releases pending cleanup')
        await jobs.wait(jobId, 5_000, parent.id)
      }
      await parentDisposal
    }
  },
)
