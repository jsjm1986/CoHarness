/**
 * The plan read store resolves the logged invocation through the Session's
 * call-history channel: a retained Session's `readCallHistory` reassembles
 * one call's turn, and the `submitted-plan` Node carries the document. Reads
 * publish per address once, distinguish unavailable/missing/failed, and
 * publish nothing after cancellation.
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  ChatConversationViewNode, ChatSnapshot, ISessions, SessionReference, SessionTarget,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { PlanReadStore, type PlanRead } from '../src/client/plan-resource.ts'
import { planAddress } from '../src/client/plan.ts'

const SID = 's-1' as SessionId

function planNode(callId: string, title = 'Draft'): ChatConversationViewNode {
  return {
    key: `submitted-plan:${callId}`, kind: 'submitted-plan', id: callId, target: 'chat',
    anchorSeq: 5, location: { kind: 'unresolved' }, visibility: 'hidden',
    data: { callId, markdown: `# ${title}`, title },
  }
}

function chatWith(nodes: readonly ChatConversationViewNode[]): ChatSnapshot {
  return {
    order: [], locations: { getTurn: () => [], getStep: () => [] },
    navigation: { items: () => [] },
    timeline: { turnOrder: [], turns: new Map() },
    legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
    nodes: { get: (key: string) => nodes.find(node => node.key === key), values: () => [...nodes] },
  }
}

interface Fake {
  sessions: ISessions
  retain: ReturnType<typeof vi.fn>
  readCallHistory: ReturnType<typeof vi.fn>
  released: ReturnType<typeof vi.fn>
  ready: Promise<unknown>
}

function fake(readCallHistory?: ReturnType<typeof vi.fn>, ready?: Promise<unknown>): Fake {
  const released = vi.fn()
  const read = readCallHistory ?? vi.fn(async () => chatWith([]))
  const retain = vi.fn((_target: SessionTarget, _options: unknown): SessionReference => ({
    sessionId: SID,
    binding: { session: { readCallHistory: read } } as never as SessionReference['binding'],
    ready: (ready ?? Promise.resolve()) as never,
    release: released,
    [Symbol.dispose]: released,
  }))
  const sessions = { retain } as unknown as ISessions
  return { sessions, retain, readCallHistory: read, released, ready: ready ?? Promise.resolve() }
}

const ADDRESS = planAddress({ session: { kind: 'session', sessionId: SID }, callId: 'c-1' as ToolCallId })

describe('PlanReadStore', () => {
  it('publishes the assembled plan for a logged invocation', async () => {
    const read = vi.fn(async () => chatWith([planNode('c-1'), planNode('c-2', 'Other')]))
    const { sessions } = fake(read)
    const store = new PlanReadStore(sessions)
    await store.load(ADDRESS)
    expect(read).toHaveBeenCalledWith('c-1', expect.any(AbortSignal))
    expect(store.state.getSnapshot()[ADDRESS]).toEqual({
      status: 'ready', plan: { callId: 'c-1', markdown: '# Draft', title: 'Draft' },
    })
    await store.dispose()
  })

  it('dedupes loads and re-reads after reset', async () => {
    const read = vi.fn(async () => chatWith([planNode('c-1')]))
    const { sessions } = fake(read)
    const store = new PlanReadStore(sessions)
    await store.load(ADDRESS)
    await store.load(ADDRESS)
    expect(read).toHaveBeenCalledTimes(1)
    store.reset()
    expect(store.state.getSnapshot()[ADDRESS]).toBeUndefined()
    await store.load(ADDRESS)
    expect(read).toHaveBeenCalledTimes(2)
    await store.dispose()
  })

  it('retains the subagent address carried by a subagent plan address', async () => {
    const read = vi.fn(async () => chatWith([planNode('x')]))
    const { sessions, retain } = fake(read)
    const store = new PlanReadStore(sessions)
    const address = planAddress({
      session: { kind: 'subagent', parentSessionId: 'p' as SessionId, childSessionId: 'c' as SessionId, mode: 'one-shot' },
      callId: 'x' as ToolCallId,
    })
    await store.load(address)
    expect(retain).toHaveBeenCalledWith(
      { parentSessionId: 'p', childSessionId: 'c', mode: 'one-shot' },
      { source: 'planPreview', signal: expect.any(AbortSignal) as AbortSignal },
    )
    expect((store.state.getSnapshot()[address] as PlanRead & { status: 'ready' }).plan.callId).toBe('x')
    await store.dispose()
  })

  it('reports invalid addresses without touching the Session', async () => {
    const { sessions, retain } = fake()
    const store = new PlanReadStore(sessions)
    await store.load('dsh-resource://plan/only-one')
    expect(retain).not.toHaveBeenCalled()
    const failed = store.state.getSnapshot()['dsh-resource://plan/only-one'] as PlanRead & { status: 'failed' }
    expect(failed.failure.code).toBe('plan/invalid-address')
    await store.dispose()
  })

  it('reports unavailable when the Session cannot be opened', async () => {
    const { sessions } = fake(undefined, Promise.reject(new Error('no such session')))
    const store = new PlanReadStore(sessions)
    await store.load(ADDRESS)
    const read = store.state.getSnapshot()[ADDRESS] as PlanRead & { status: 'failed' }
    expect(read.failure).toEqual({ code: 'plan/unavailable', message: 'no such session' })
    await store.dispose()
  })

  it('reports not-found when the assembled window lacks the invocation', async () => {
    const { sessions } = fake(vi.fn(async () => chatWith([planNode('other')])))
    const store = new PlanReadStore(sessions)
    await store.load(ADDRESS)
    expect((store.state.getSnapshot()[ADDRESS] as PlanRead & { status: 'failed' }).failure.code).toBe('plan/not-found')
    await store.dispose()
  })

  it('reports read failures with the thrown diagnostic', async () => {
    const { sessions } = fake(vi.fn(async () => { throw new Error('connection lost') }))
    const store = new PlanReadStore(sessions)
    await store.load(ADDRESS)
    expect((store.state.getSnapshot()[ADDRESS] as PlanRead & { status: 'failed' }).failure)
      .toEqual({ code: 'plan/read-failed', message: 'connection lost' })
    await store.dispose()
  })

  it('reports unavailable for a persisted unknown-mode subagent identity', async () => {
    const { sessions, retain } = fake()
    const store = new PlanReadStore(sessions)
    const address = 'dsh-resource://plan/subagent/p/c/unknown/x'
    await store.load(address)
    expect(retain).not.toHaveBeenCalled()
    expect((store.state.getSnapshot()[address] as PlanRead & { status: 'failed' }).failure.code).toBe('plan/unavailable')
    await store.dispose()
  })

  it('publishes nothing after a generation reset', async () => {
    let finish!: (snapshot: ChatSnapshot) => void
    const read = vi.fn(() => new Promise<ChatSnapshot>((done) => { finish = done }))
    const { sessions } = fake(read)
    const store = new PlanReadStore(sessions)
    const loading = store.load(ADDRESS)
    // Let the retain/ready wait settle so the history read is in flight.
    await Promise.resolve()
    expect(read).toHaveBeenCalled()
    store.reset()
    finish(chatWith([planNode('c-1')]))
    await loading
    expect(store.state.getSnapshot()[ADDRESS]).toBeUndefined()
    await store.dispose()
  })
})
