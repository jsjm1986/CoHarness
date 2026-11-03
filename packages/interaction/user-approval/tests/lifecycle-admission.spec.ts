/** Pending approval cannot reach an answerer or authorize execution after its request or service is withdrawn. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalOutcome } from '../src/index.ts'
import { setImmediate } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(ApprovalService)
  const session = ctx.sessions.create(SessionId('approval-lifecycle'))
  session.append('turn/start', { turn: 1 })
  // Dispatch and policy writes use the real Session; the stand-in supplies routing identity and injection.
  const agent = { session, inject: () => {} } as unknown as Agent
  return { ctx, fiber, session, agent, service: ctx.approval }
}

it('withdraws a cancelled request before its queued answerer dispatch', async () => {
  const f = await fixture(), controller = new AbortController()
  let entered = 0
  f.ctx.on('approval/request', () => { entered++; return Promise.resolve<ApprovalOutcome>('allowed-once') })
  const pending = f.service.request({ agent: f.agent, toolName: 'write', signal: controller.signal })
  controller.abort(new Error('caller cancelled before dispatch'))
  expect(await pending).toBe('cancelled')
  expect(entered).toBe(0)
  expect(f.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(1)
})

it('cannot use a withdrawn service reference to bypass the replacement policy', async () => {
  const f = await fixture()
  await f.fiber.dispose()
  await f.ctx.plugin(ApprovalService, { policy: 'never' })
  f.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
  const before = f.session.seq
  await expect(f.service.request({ agent: f.agent, toolName: 'write' })).rejects.toThrow('withdrawn')
  expect(() => { f.service.setPolicy(f.agent, 'never') }).toThrow('withdrawn')
  expect(f.session.seq).toBe(before)
  await expect(f.ctx.approval.request({ agent: f.agent, toolName: 'write' })).resolves.toBe('rejected')
})

it('settles the audit pair before withdrawal finishes and discards a late grant', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), answer = Promise.withResolvers<ApprovalOutcome>()
  f.ctx.on('approval/request', () => { entered.resolve(undefined); return answer.promise })
  const pending = f.service.request({ agent: f.agent, toolName: 'write' })
  try {
    await entered.promise
    await f.fiber.dispose()
    expect(f.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toMatchObject([
      { data: { outcome: 'cancelled' } },
    ])
  } finally { answer.resolve('allowed-once'); await pending }
  expect(await pending).toBe('cancelled')
})

it('does not enter an answerer when dispatch observation cancels the approval', async () => {
  const f = await fixture(), controller = new AbortController()
  let answerers = 0
  f.ctx.on('approval/request', () => { answerers++; return Promise.resolve<ApprovalOutcome>('allowed-once') })
  f.ctx.on('internal/dispatch', (_mode, name) => { if (name === 'approval/request') controller.abort() })
  expect(await f.service.request({ agent: f.agent, toolName: 'write', signal: controller.signal })).toBe('cancelled')
  expect(answerers).toBe(0)
})

it.each(['caller-cancelled', 'service-withdrawn'] as const)('does not resume a late approval middleware after %s', async (kind) => {
  const f = await fixture(), controller = new AbortController()
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  let answerers = 0
  f.ctx.on('approval/request', async (_request, next) => { entered.resolve(undefined); await resume.promise; return next() })
  f.ctx.on('approval/request', () => { answerers++; return Promise.resolve<ApprovalOutcome>('allowed-once') })
  const pending = f.service.request({ agent: f.agent, toolName: 'write', signal: controller.signal })
  try {
    await entered.promise
    if (kind === 'caller-cancelled') controller.abort()
    else await f.fiber.dispose()
    expect(await pending).toBe('cancelled')
    resume.resolve(undefined)
    await setImmediate()
    expect(answerers).toBe(0)
    expect(f.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toMatchObject([
      { data: { outcome: 'cancelled' } },
    ])
  } finally { resume.resolve(undefined); await pending }
})
