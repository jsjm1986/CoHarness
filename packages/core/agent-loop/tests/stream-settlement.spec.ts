/** Middleware and durable publication failures close the live attempt and leave the next turn usable. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished } from 'vitest'
import AgentLoop from '../src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'unclosed-extension': { type: 'unclosed-extension'; value: string }
  }
}

async function fixture(responses: StreamChunk[][] = [textResponse('Recovered reply'), textResponse('Recovered reply')]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new MockAdapter(responses)))
  const agent = await ctx.agentLoop.create(SessionId('stream-settlement'), { provider: 'mock', model: 'mock' })
  const prompt = () => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] })) }
  return { ctx, agent, prompt }
}

it('refuses overlapping maintenance without entering the second job', async () => {
  const { agent } = await fixture()
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const first = agent.runMaintenance(async () => { entered.resolve(undefined); await resume.promise })
  let enteredSecond = false
  try {
    await entered.promise
    expect(() => agent.runMaintenance(async () => { enteredSecond = true })).toThrow('already has active work')
    expect(enteredSecond).toBe(false)
  } finally { resume.resolve(undefined); await first }
  expect(agent.status).toBe('idle')
})

it.each(['stream', 'stream-settlement', 'message-settlement'] as const)(
  'retains the original %s failure and completes the next independent turn', async (kind) => {
    const { ctx, agent, prompt } = await fixture()
    const failure = new Error('Middleware stream failed'), settlement = new Error('Durable assistant settlement rejected')
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const stopStream = kind === 'message-settlement' ? undefined : ctx.on('llm/stream', () => (async function* () {
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'Partial output' } }
      throw failure
    })())
    const stopPublication = ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event' || args[0] !== agent.session) return
      const event = args[1] as SessionEvent
      if ((kind === 'stream-settlement' && event.type === 'assistant/attempt')
        || (kind === 'message-settlement' && event.type === 'assistant/message')) throw settlement
    })
    try {
      prompt()
      await agent.whenIdle()
      expect(agent.status).toBe('idle')
      expect(errors).toHaveLength(1)
      if (kind === 'stream-settlement') expect(errors[0]).toMatchObject({ cause: failure, errors: [failure, settlement] })
      else expect(errors[0]).toBe(kind === 'stream' ? failure : settlement)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
      expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')).toHaveLength(kind === 'stream' ? 1 : 0)
    } finally { stopStream?.(); stopPublication() }
    prompt()
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  },
)

it('retains adapter replay state when cancellation interrupts final stream cleanup', async () => {
  const replayState = { response: { id: 'original-response' }, blocks: [{ id: 'original-block' }] }
  const response = textResponse('Visible partial reply')
  response[response.length - 1] = { type: 'finish', reason: { kind: 'stop' }, replayState }
  const { ctx, agent, prompt } = await fixture([response])
  ctx.on('llm/stream', (_options, next) => (async function* () {
    for await (const chunk of next()) {
      yield chunk
      if (chunk.type === 'finish') agent.cancel({ kind: 'user' })
    }
  })())
  prompt()
  await agent.whenIdle()
  const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
  expect(message).toMatchObject({ data: { interrupted: true, message: { source: { replayState } } } })
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
})

it('abandons an attempt when an extension block ends without a closing value and accepts the next turn', async () => {
  const { ctx, agent, prompt } = await fixture([[
    { type: 'block-start', index: 0, blockType: 'unclosed-extension' },
    { type: 'finish', reason: { kind: 'stop' } },
  ], textResponse('Recovered reply')])
  const errors: unknown[] = [], frames: AssistantStreamFrame[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  ctx.on('agent/assistant-stream', ({ frame }) => { frames.push(frame) })
  prompt()
  await agent.whenIdle()
  expect(errors).toEqual([expect.objectContaining({ message: 'cannot assemble incomplete block of type "unclosed-extension"' })])
  expect(frames.filter(frame => frame.type === 'end')).toMatchObject([{ outcome: { kind: 'abandoned' } }])
  expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
  prompt()
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
})
