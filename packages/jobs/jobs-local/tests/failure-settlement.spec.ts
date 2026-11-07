/** Exception reporting cannot prevent registry settlement or teardown. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

describe('LocalJobRegistry unrenderable failures', () => {
  it.each(['producer', 'source', 'teardown'] as const)('settles after a %s failure without string coercion', async (stage) => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalJobRegistry)
    const jobs = ctx.jobs
    jobs.attachController('failure-settlement-test')
    const terminal = Promise.withResolvers<JobOutcome>()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const outcomes: JobOutcome['status'][] = []
    jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled') outcomes.push(event.job.status as JobOutcome['status'])
    })
    const failure: unknown = Object.create(null)
    const spec: JobSpec = {
      kind: 'bash', label: 'unrenderable failure',
      ...(stage === 'source' ? { output: [{ read() { throw failure } }] } : {}),
      run: () => ({
        cancel() { throw stage === 'teardown' ? failure : new Error('release failed test job') },
        done: terminal.promise,
      }),
    }
    try {
      const id = jobs.start(spec)
      if (stage === 'teardown') {
        await fiber.dispose()
        expect(outcomes).toEqual(['failed'])
        expect(jobs.list()).toEqual([])
      } else {
        if (stage === 'producer') terminal.reject(failure)
        else terminal.resolve({ status: 'completed' })
        const result = await jobs.wait(id, 100)
        expect(result.status).toBe(stage === 'producer' ? 'failed' : 'completed')
        if (stage === 'producer') expect(result.detail).toBe('[unrenderable thrown value]')
      }
      expect(warn.mock.calls.some(args => String(args[0]).includes('[unrenderable thrown value]'))).toBe(true)
    } finally {
      terminal.resolve({ status: 'killed' })
      await ctx.fiber.dispose()
    }
  })
})

it.each(['completed', 'failed', 'killed'] as const)('keeps committed %s settlement ahead of abort from a journal observer', async (status) => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  const jobs = ctx.jobs
  jobs.attachController('journal-wait-test')
  const ownerScope = await ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(`journal-abort-${status}`))
  const owner: Agent = {
    id: session.id, session, options: {}, ctx: ownerScope.ctx, status: 'idle', inbox: unsupportedInbox(),
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(owner)
  const terminal = Promise.withResolvers<JobOutcome>()
  try {
    const id = jobs.start({ kind: 'bash', label: 'settlement observer abort', owner: owner.id,
      run: () => ({ cancel: () => { terminal.resolve({ status: 'killed' }) }, done: terminal.promise }) })
    const controller = new AbortController()
    ctx.on('session/event', (current, event) => {
      if (current === session && event.type === 'job/settled' && event.data.jobId === id) controller.abort()
    })
    const waiting = jobs.wait(id, 1000, owner.id, controller.signal)
    terminal.resolve({ status })
    await expect(waiting).resolves.toMatchObject({ status })
    expect(controller.signal.aborted).toBe(true)
  } finally { terminal.resolve({ status: 'killed' }); await ctx.fiber.dispose() }
})
