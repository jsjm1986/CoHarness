/** A request from another LLM instance cannot consume this Runtime's pending title revision. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { createUserMessage, deepFreeze, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService, { SessionTitleProviderId } from '../src/index.ts'
import { expect, it, onTestFinished } from 'vitest'

it('ignores a foreign loop request and preserves its pending revision for the local loop request', async () => {
  const origin = new Context(), destination = new Context()
  const captured = Promise.withResolvers<GenerateOptions>(), finish = Promise.withResolvers<undefined>()
  const id = SessionId('same-id-in-independent-runtimes')
  onTestFinished(async () => {
    finish.resolve(undefined)
    await destination.fiber.dispose()
    await origin.fiber.dispose()
  })
  try {
    await mountAgentLoopTestDependencies(origin)
    const driver = await mountAgentLoopTestHarness(origin)
    class Held extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 64 }
      }
      override async *stream(): AsyncIterable<StreamChunk> {
        await finish.promise
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Original reply' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    origin.effect(() => origin.llm.registerAdapter(['mock'], new Held()))
    origin.on('llm/stream', (options, next) => { captured.resolve(options); return next() })
    const agent = await driver.create(id, { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Origin request' }] }))
    const foreign = await captured.promise
    expect(Object.isFrozen(foreign)).toBe(true)

    await destination.plugin(LlmRuntime)
    await destination.plugin(SessionStore)
    await destination.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 64, maxTitleBytes: 64 })
    class Immediate extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    destination.effect(() => destination.llm.registerAdapter(['mock'], new Immediate()))
    let calls = 0
    const firstTitle = Promise.withResolvers<undefined>()
    destination.sessionTitle.register({
      id: SessionTitleProviderId('runtime-owned'), automatic: 'all-prompts',
      async generate(request) { calls++; return { title: `Revision ${calls}`, messageSeqs: request.messages.map(message => message.seq) } },
    })
    const session = destination.sessions.create(id)
    destination.on('session/event', (owner, event) => {
      if (owner === session && event.type === 'session/title' && event.data.source.kind === 'provider') firstTitle.resolve(undefined)
    })
    const prompt = (text: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 }); prompt('First destination prompt')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    await firstTitle.promise
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 }); prompt('Second destination prompt')
    session.append('step/start', { turn: 2, step: 1 })
    for await (const _chunk of destination.llm.stream(foreign)) { /* The independent one-shot stream is fully consumed. */ }
    await setImmediate()
    expect(calls).toBe(1)
    expect(destination.sessionTitle.get(session)?.title).toBe('Revision 1')
    const local = destination.llm.markAgentLoopRequest(deepFreeze({ provider: 'mock', model: 'mock', messages: session.deriveMessages(), sessionId: id }))
    for await (const _chunk of destination.llm.stream(local)) { /* Complete the local main-request boundary. */ }
    await setImmediate()
    expect(calls).toBe(2)
    expect(destination.sessionTitle.get(session)?.title).toBe('Revision 2')
  } finally {
    finish.resolve(undefined)
    await destination.fiber.dispose()
    await origin.fiber.dispose()
  }
})
