/** Foreground questions retain cancellation and their exact service and Agent while answerers wait. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import UserQuestionService, { type AskUserQuestionAnswer } from '../src/index.ts'

const questions = [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'Approve' }] }]
const approved: AskUserQuestionAnswer = { answers: [{ id: 'confirm', selected: ['Approve'] }] }

async function fixture(agents = false) {
  const ctx = new Context()
  const cleanups: Array<() => void> = []
  onTestFinished(async () => { for (const cleanup of cleanups) cleanup(); await ctx.fiber.dispose() })
  if (agents) {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
  }
  const fiber = await ctx.plugin(UserQuestionService)
  return { ctx, fiber, cleanup: (action: () => void) => { cleanups.push(action) } }
}

it('refuses a retained retired service before invoking any answerer', async () => {
  const { ctx, fiber } = await fixture(), service = ctx.userQuestions
  const answerer = vi.fn(async () => approved)
  ctx.on('user-questions/request', answerer)
  await fiber.dispose()
  await expect(service.ask({ questions })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  expect(answerer).not.toHaveBeenCalled()
})

it('does not enter an answerer after cancellation before the queued waterfall', async () => {
  const { ctx } = await fixture(), controller = new AbortController()
  const answerer = vi.fn(async () => approved)
  ctx.on('user-questions/request', answerer)
  const result = ctx.userQuestions.ask({ questions, signal: controller.signal })
  controller.abort()
  await expect(result).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  expect(answerer).not.toHaveBeenCalled()
})

it('refuses an answerer when dispatch observation cancels the question', async () => {
  const { ctx } = await fixture(), controller = new AbortController()
  const answerer = vi.fn(async () => approved)
  ctx.on('user-questions/request', answerer)
  ctx.on('internal/dispatch', (_mode, name) => { if (name === 'user-questions/request') controller.abort() })
  await expect(ctx.userQuestions.ask({ questions, signal: controller.signal })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  expect(answerer).not.toHaveBeenCalled()
})

it('prevents a delayed middleware continuation from entering another answerer after cancellation', async () => {
  const { ctx, cleanup } = await fixture(), controller = new AbortController()
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  cleanup(() => { resume.resolve(undefined) })
  ctx.on('user-questions/request', async (_request, next) => { entered.resolve(undefined); await resume.promise; return next() })
  const answerer = vi.fn(async () => approved)
  ctx.on('user-questions/request', answerer)
  const result = ctx.userQuestions.ask({ questions, signal: controller.signal })
    .then(answer => ({ answer }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    controller.abort()
    expect(await result).toMatchObject({ error: { code: 'ASK_ABORTED' } })
    resume.resolve(undefined)
    await setImmediate()
    expect(answerer).not.toHaveBeenCalled()
  } finally { resume.resolve(undefined); await result }
})

it.each(['caller-cancelled', 'service-withdrawn'] as const)('settles a %s question before an ignoring answerer returns', async (kind) => {
  const { ctx, fiber, cleanup } = await fixture(), controller = new AbortController()
  const entered = Promise.withResolvers<undefined>(), reply = Promise.withResolvers<AskUserQuestionAnswer>()
  cleanup(() => { reply.resolve(approved) })
  let signal: AbortSignal | undefined, settled: unknown
  ctx.on('user-questions/request', (request) => { signal = request.signal; entered.resolve(undefined); return reply.promise })
  const result = ctx.userQuestions.ask({ questions, signal: controller.signal })
    .then((answer) => { settled = { answer } }, (error: unknown) => { settled = { error } })
  try {
    await entered.promise
    if (kind === 'caller-cancelled') controller.abort()
    else await fiber.dispose()
    await setImmediate()
    expect(settled).toMatchObject({ error: { code: 'ASK_ABORTED' } })
    expect(signal?.aborted).toBe(true)
    reply.resolve(approved)
    await result
    expect(settled).toMatchObject({ error: { code: 'ASK_ABORTED' } })
  } finally { reply.resolve(approved); await result }
})

it.each(['disposed', 'replaced'] as const)('refuses a foreground answer after its actual Agent is %s', async (kind) => {
  const { ctx, cleanup } = await fixture(true)
  const handle = await ctx.agents.create({ sessionId: SessionId(`question-owner-${kind}`) })
  const entered = Promise.withResolvers<undefined>(), reply = Promise.withResolvers<AskUserQuestionAnswer>()
  cleanup(() => { reply.resolve(approved) })
  ctx.on('user-questions/request', () => { entered.resolve(undefined); return reply.promise })
  const result = ctx.userQuestions.ask({ questions, agent: handle.agent })
    .then(answer => ({ answer }), (error: unknown) => ({ error }))
  let replacement: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
  try {
    await entered.promise
    await handle.dispose()
    if (kind === 'replaced') replacement = await ctx.agents.create({ sessionId: handle.agent.id })
    reply.resolve(approved)
    expect(await result).toMatchObject({ error: { code: 'CALLER_NOT_LIVE' } })
  } finally { reply.resolve(approved); await result; await replacement?.dispose(); await handle.dispose() }
})

it('holds idle retirement while a foreground question still belongs to that Agent', async () => {
  const { ctx, cleanup } = await fixture(true)
  const handle = await ctx.agents.create({ sessionId: SessionId('question-idle-retirement') })
  const entered = Promise.withResolvers<undefined>(), reply = Promise.withResolvers<AskUserQuestionAnswer>()
  cleanup(() => { reply.resolve(approved) })
  ctx.on('user-questions/request', () => { entered.resolve(undefined); return reply.promise })
  const result = ctx.userQuestions.ask({ questions, agent: handle.agent })
    .then(answer => ({ answer }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    expect(await handle.tryDisposeIdle()).toBe(false)
    expect(ctx.agents.get(handle.agent.id)).toBe(handle.agent)
    reply.resolve(approved)
    expect(await result).toEqual({ answer: approved })
    expect(await handle.tryDisposeIdle()).toBe(true)
  } finally { reply.resolve(approved); await result; await handle.dispose() }
})

it('holds idle retirement during an unattended timed wait and releases it on cancellation', async () => {
  const { ctx, cleanup } = await fixture(true), controller = new AbortController()
  cleanup(() => { controller.abort() })
  const handle = await ctx.agents.create({ sessionId: SessionId('timed-question-idle-retirement') })
  const result = ctx.userQuestions.askTimed({ questions, agent: handle.agent, signal: controller.signal },
    ToolCallId('timed-retirement'), 30_000)
    .then(answer => ({ answer }), (error: unknown) => ({ error }))
  try {
    await setImmediate()
    expect(await handle.tryDisposeIdle()).toBe(false)
    controller.abort()
    expect(await result).toMatchObject({ error: { code: 'ASK_ABORTED' } })
    expect(await handle.tryDisposeIdle()).toBe(true)
  } finally { controller.abort(); await result; await handle.dispose() }
})

it('withdraws only the disposed Agent question while another Agent can still answer', async () => {
  const { ctx, cleanup } = await fixture(true)
  const first = await ctx.agents.create({ sessionId: SessionId('question-isolation-first') })
  const second = await ctx.agents.create({ sessionId: SessionId('question-isolation-second') })
  const replies = new Map([
    [first.agent.id, Promise.withResolvers<AskUserQuestionAnswer>()],
    [second.agent.id, Promise.withResolvers<AskUserQuestionAnswer>()],
  ])
  cleanup(() => { for (const reply of replies.values()) reply.resolve(approved) })
  const entered = Promise.withResolvers<undefined>(), signals = new Map<string, AbortSignal | undefined>()
  ctx.on('user-questions/request', (request) => {
    if (request.agent === undefined) throw new Error('This isolation fixture requires an Agent')
    signals.set(request.agent.id, request.signal)
    if (signals.size === 2) entered.resolve(undefined)
    const reply = replies.get(request.agent.id)
    if (reply === undefined) throw new Error('This Agent has no owned reply')
    return reply.promise
  })
  const a = ctx.userQuestions.ask({ questions, agent: first.agent }).then(answer => ({ answer }), (error: unknown) => ({ error }))
  const b = ctx.userQuestions.ask({ questions, agent: second.agent }).then(answer => ({ answer }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    await first.dispose()
    expect(await a).toMatchObject({ error: { code: 'CALLER_NOT_LIVE' } })
    expect(signals.get(first.agent.id)?.aborted).toBe(true)
    expect(signals.get(second.agent.id)?.aborted).toBe(false)
    expect(await second.tryDisposeIdle()).toBe(false)
    replies.get(second.agent.id)?.resolve(approved)
    expect(await b).toEqual({ answer: approved })
    replies.get(first.agent.id)?.resolve(approved)
  } finally {
    for (const reply of replies.values()) reply.resolve(approved)
    await Promise.all([a, b]); await first.dispose(); await second.dispose()
  }
})
