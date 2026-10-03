/**
 * Card-registry wiring on a real cordis Context + SlotRegistry: wire PendingWait
 * adoption into PendingQuestion cards, Session pending-feed publication, the
 * timed-wait Remote claim stream, the projection-driven continued path, the
 * late-reply node, and fiber teardown. Component behavior is covered
 * props-direct in user-questions-composer.spec.tsx.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcReceipt } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { PendingUserQuestion } from '@deepseek-ai/dsh-user-questions/types'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { PendingQuestion } from '../src/client/contract/slots.ts'
import { apply, inject } from '../src/client/index.ts'

const SESSION_ID = 'session-question' as SessionId
const CALL = ToolCallId('call-timed')
const QUESTIONS = [{ id: 'mode', question: 'Choose a mode' }] as const
const ANSWER = { answers: [{ id: 'mode', selected: ['Fast'] }] }
const CONTINUED: PendingUserQuestion = { callId: CALL, questions: [...QUESTIONS], state: 'continued' }

/** One wire `question/requested` wait over a scripted respond carrier. */
function wireWait(rpcId = 'question-1', payload: object = { questions: [...QUESTIONS] }) {
  const respond = vi.fn(async (): Promise<RpcReceipt> => ({ accepted: true }))
  const wait = new PendingWait('question', RpcId(rpcId), SESSION_ID, payload as never, respond)
  return { wait, respond }
}

/**
 * ctx service stubs the plugin consumes: the Session list + bound Session face
 * (pending feed, projection face, publishInteraction), the userQuestions Remote
 * (attachWait stream + late answer), the conversation node registry, and the
 * slot/locale seats.
 */
async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    slots.register(
      {
        name: 'root',
        children: {
          'conversation.composer': { kind: 'chain', scope: 'session' },
          'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        },
      } as never,
      () => null,
    )
  }
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)

  const projection = createSnapshotStore<{ active: readonly PendingUserQuestion[]; settled: readonly never[] }>({ active: [], settled: [] })
  const sessionStore = createSnapshotStore<{ pending: readonly PendingWait[] }>({ pending: [] })
  const session = {
    subscribe: (listener: () => void) => sessionStore.subscribe(listener),
    getSnapshot: () => sessionStore.getSnapshot(),
    projections: { faceOf: () => projection },
    publishInteraction: vi.fn((_entry: object) => () => {}),
  }
  const list = createSnapshotStore({
    ids: [SESSION_ID],
    byId: { [SESSION_ID]: { id: SESSION_ID } },
    phase: 'ready',
  })
  const binding = vi.fn((sessionId: SessionId) => (
    sessionId === SESSION_ID ? { sessionId: SESSION_ID, session } : undefined
  ))
  const retain = vi.fn((_sessionId: SessionId, _options: object) => ({
    ready: Promise.resolve(),
    release: vi.fn(),
  }))
  ctx.provide('sessions', { list, binding, retain } as never)

  const attachWait = vi.fn((_sessionId: SessionId, _callId: ToolCallId, signal: AbortSignal) => {
    const ended = Promise.withResolvers<IteratorResult<{ remainingMs: number }>>()
    const dispose = (): void => {
      signal.removeEventListener('abort', dispose)
      ended.resolve({ done: true, value: undefined })
    }
    signal.addEventListener('abort', dispose, { once: true })
    let first = true
    return {
      dispose, send: () => {}, end: () => {},
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (!first) return ended.promise
          first = false
          return Promise.resolve({ done: false as const, value: { remainingMs: 60_000 } })
        },
      }),
    }
  })
  const answer = vi.fn(async () => ({ ok: true as const, value: true }))
  ctx.provide('remote.userQuestions', { attachWait, answer } as never)
  ctx.provide('remote', { userQuestions: { attachWait, answer } } as never)
  const registerNode = vi.fn((_definition: { kind: string }) => () => {})
  ctx.provide('conversationEvents', { register: registerNode } as never)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
  return {
    ctx, slots, locale, fiber, session, list, binding, projection,
    attachWait, answer, registerNode, retain,
    flush,
    /** Install or retract a wire wait in the Session pending feed. */
    setPending(waits: readonly PendingWait[]): void {
      sessionStore.set({ pending: waits })
    },
  }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'remote', 'remote.userQuestions', 'slots', 'locale', 'conversationEvents'])
  })

  it('registers the question entry: routing selector and keyed card hook', async () => {
    const b = await bench()
    const entry = b.slots.entries('conversation.composer')[0]!
    expect(entry.component).toBe(QuestionComposer)
    expect(entry.locale).toBe('question')
    const select = entry.select as (owner: { interactions: readonly object[] }) => unknown
    const question = new PendingQuestion(SESSION_ID, [...QUESTIONS])
    expect(select({ interactions: [{}, question] })).toBe(question)
    expect(select({ interactions: [{}] })).toBeNull()
  })

  it('registers the late-reply conversation node with the conversation runtime', async () => {
    const b = await bench()
    expect(b.registerNode).toHaveBeenCalledWith(expect.objectContaining({ kind: 'user-question-reply' }))
    expect(b.slots.entries('conversation.chat.node').some(entry => entry.options.key === 'question-reply')).toBe(true)
  })

  it('adopts a wire wait into a published card that answers through respond', async () => {
    const b = await bench()
    try {
      const { wait, respond } = wireWait()
      b.setPending([wait])
      await b.flush()
      const card = b.session.publishInteraction.mock.calls[0]?.[0] as PendingQuestion | undefined
      expect(card).toBeInstanceOf(PendingQuestion)
      expect(card?.snapshot().channel).toBe('waterfall')
      await card!.answer(ANSWER)
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({
        result: { ok: true, value: { sessionId: SESSION_ID, answer: ANSWER } },
      }))
    } finally {
      await b.fiber.dispose()
    }
  })

  it('a request the Host never named ends with a cancelled wire response when the user closes its panel', async () => {
    const b = await bench()
    try {
      const { wait, respond } = wireWait()
      b.setPending([wait])
      await b.flush()
      const card = b.session.publishInteraction.mock.calls[0]?.[0] as PendingQuestion
      expect(card.dismissal).toBe('cancel')
      await card.dismiss()
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({
        result: { ok: false, error: { code: 'cancelled', message: 'the user cancelled ask_user_question', details: {} } },
      }))
    } finally {
      await b.fiber.dispose()
    }
  })

  it('opens the Remote claim stream once for a timed wait and anchors the deadline', async () => {
    const b = await bench()
    try {
      const { wait } = wireWait('question-timed', {
        questions: [...QUESTIONS],
        wait: { callId: CALL, timed: true },
      })
      b.setPending([wait])
      await b.flush()
      expect(b.attachWait).toHaveBeenCalledTimes(1)
      expect(b.attachWait.mock.calls[0]?.[0]).toBe(SESSION_ID)
      expect(b.attachWait.mock.calls[0]?.[1]).toBe(CALL)
      // The waterfall attaches only after the opening frame lands the deadline.
      await vi.waitFor(() => {
        const card = b.session.publishInteraction.mock.calls[0]?.[0] as PendingQuestion
        expect(card.snapshot().countdown?.running).toBe(true)
      })
    } finally {
      await b.fiber.dispose()
    }
  })

  it('a timed-out card rejects the wire wait with the timed-out code', async () => {
    const b = await bench()
    try {
      const { wait, respond } = wireWait('question-timed', {
        questions: [...QUESTIONS],
        wait: { callId: CALL, timed: true },
      })
      b.setPending([wait])
      await b.flush()
      const card = b.session.publishInteraction.mock.calls[0]?.[0] as PendingQuestion
      await vi.waitFor(() => { expect(card.snapshot().countdown?.running).toBe(true) })
      card.timeout()
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({
        result: { ok: false, error: { code: 'timed-out', message: 'ask_user_question timed out before the user answered', details: {} } },
      }))
    } finally {
      await b.fiber.dispose()
    }
  })

  it('a reconnect replay of the same wait reuses the card instead of minting a twin', async () => {
    const b = await bench()
    try {
      const first = wireWait('question-same', { questions: [...QUESTIONS], wait: { callId: CALL } })
      b.setPending([first.wait])
      await b.flush()
      // Resolved+re-requested replay: the same rpcId arrives again.
      const replay = wireWait('question-same', { questions: [...QUESTIONS], wait: { callId: CALL } })
      b.setPending([replay.wait])
      await b.flush()
      const cards = b.session.publishInteraction.mock.calls.map(call => call[0])
      expect(new Set(cards).size).toBe(1)
    } finally {
      await b.fiber.dispose()
    }
  })

  it('a call-less card ends when its wait leaves the pending feed', async () => {
    const b = await bench()
    try {
      const { wait } = wireWait()
      b.setPending([wait])
      await b.flush()
      const card = b.session.publishInteraction.mock.calls[0]?.[0] as PendingQuestion
      b.setPending([])
      await b.flush()
      expect(card.snapshot().closed).toBe(true)
    } finally {
      await b.fiber.dispose()
    }
  })

  it('a call-keyed card survives its wait leaving the feed while the projection still lists it', async () => {
    const b = await bench()
    try {
      const { wait } = wireWait('question-timed', {
        questions: [...QUESTIONS],
        wait: { callId: CALL, timed: true },
      })
      b.setPending([wait])
      b.projection.set({ active: [CONTINUED], settled: [] })
      await b.flush()
      const card = b.session.publishInteraction.mock.calls[0]?.[0] as PendingQuestion
      // The Host ended the wire wait (timed ask returned pending); the row continues.
      b.setPending([])
      await b.flush()
      expect(card.snapshot().closed).toBe(false)
      expect(card.snapshot().state).toBe('continued')
    } finally {
      await b.fiber.dispose()
    }
  })

  it('creates a continued card from the projection and answers it through the Remote path', async () => {
    const b = await bench()
    try {
      b.projection.set({ active: [CONTINUED], settled: [] })
      await b.flush()
      const card = b.session.publishInteraction.mock.calls[0]?.[0] as PendingQuestion
      expect(card).toBeInstanceOf(PendingQuestion)
      expect(card.callId).toBe(CALL)
      expect(card.snapshot().channel).toBe('rpc')
      await card.answer(ANSWER)
      expect(b.answer).toHaveBeenCalledWith(SESSION_ID, CALL, ANSWER)
    } finally {
      await b.fiber.dispose()
    }
  })

  it('drops a call-keyed card once the projection stops listing its call', async () => {
    const b = await bench()
    try {
      b.projection.set({ active: [CONTINUED], settled: [] })
      await b.flush()
      const card = b.session.publishInteraction.mock.calls[0]?.[0] as PendingQuestion
      b.projection.set({ active: [], settled: [] })
      await b.flush()
      expect(card.snapshot().closed).toBe(true)
    } finally {
      await b.fiber.dispose()
    }
  })

  it('retains the card session scope while a card is live and releases it on close', async () => {
    const b = await bench()
    try {
      b.projection.set({ active: [CONTINUED], settled: [] })
      await b.flush()
      expect(b.retain).toHaveBeenCalledWith(SESSION_ID, { source: 'userQuestion' })
      const reference = b.retain.mock.results[0]?.value as { release: ReturnType<typeof vi.fn> }
      expect(reference.release).not.toHaveBeenCalled()
      b.projection.set({ active: [], settled: [] })
      await b.flush()
      expect(reference.release).toHaveBeenCalledTimes(1)
    } finally {
      await b.fiber.dispose()
    }
  })

  it('teardown delegates live waits so their Host requests release instead of parking', async () => {
    const b = await bench()
    const { wait, respond } = wireWait()
    b.setPending([wait])
    await b.flush()
    await b.fiber.dispose()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      result: { ok: false, error: { code: 'cancelled', message: 'the user cancelled ask_user_question', details: {} } },
    }))
  })

  it('withdraws the panel provider with the plugin lifetime', async () => {
    const b = await bench()
    expect(b.ctx.get('userQuestionPanels')).toBeDefined()
    await b.fiber.dispose()
    expect(b.ctx.get('userQuestionPanels')).toBeUndefined()
  })
})
