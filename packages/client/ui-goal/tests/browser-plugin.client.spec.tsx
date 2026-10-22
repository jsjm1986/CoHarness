// @vitest-environment jsdom
/**
 * ui-goal browser half on a real cordis Context with fake slots/api/
 * sessions faces: the plugin registers the GoalBar dock entry at
 * conversation.input.dock, the inject face's four verbs read the CAS ref
 * from the session's CURRENT projected value at call time (no fence — the
 * Remote method's compare-and-set is the guard), a missing projection short-circuits
 * to the no-current-goal error without touching the wire, and a Remote failure
 * reaches the strip verbatim. Registration disposal rides the
 * plugin fiber (HMR safety). The node half and the invariant companion are
 * exercised over the same Context.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'
import { createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-runtime/src/client/conversation/event-registry.ts'
import type { GoalActivation, GoalId, GoalProjection, GoalView } from '@deepseek-ai/dsh-goal/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { GoalActivationSnapshot, GoalBarActions, GoalBarInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { GoalDock } from '../src/client/GoalBar.tsx'
import { zh } from '../src/client/locales.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId
const GOAL_ID = 'g-1' as GoalId

function makeProjection(revision = 3): GoalProjection {
  return {
    goal: {
      id: GOAL_ID,
      revision,
      objective: 'Ship it',
      phase: 'active',
      maxGoalRounds: 8,
    },
    roundsStarted: 1,
    createdAt: 10,
    updatedAt: 20,
  }
}

/** Boot the plugin over fake faces; Goal Remote methods record arguments and answer per the script. */
async function bench(options: {
  projection?: GoalProjection | null | undefined
  activation?: GoalActivation
  failWith?: { code: string; message: string; details: object }
} = {}) {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  const conversationEvents = new ConversationEventRegistry(ctx)
  function answer<T>(method: string, value: T) {
    return (...args: unknown[]) => {
      calls.push({ method, args })
      if (options.failWith !== undefined) return Promise.resolve({ ok: false, error: options.failWith })
      return Promise.resolve({ ok: true, value })
    }
  }
  const ref = { id: 'g-1', revision: 3 }
  const goalView = (): GoalView | undefined => {
    if (options.projection === null || options.projection === undefined) return undefined
    return {
      ...options.projection.goal,
      roundsStarted: options.projection.roundsStarted,
      createdAt: options.projection.createdAt,
      updatedAt: options.projection.updatedAt,
      activation: options.activation ?? 'armed',
    }
  }
  const goals = (prefix: string) => ({
    get: answer(`${prefix}/get`, goalView()),
    edit: answer(`${prefix}/edit`, { ref }),
    pause: answer(`${prefix}/pause`, { ref }),
    resume: answer(`${prefix}/resume`, { ref }),
    clear: answer(`${prefix}/clear`, ref),
  })
  let activeGoals: ReturnType<typeof goals> | undefined = goals('goals')
  class RemoteService extends Service {
    readonly activationListeners = new Set<(event: {
      sessionId: SessionId
      goal?: { id: string; revision: number; activation: GoalActivation }
    }) => void>()

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $on(_event: string, listener: (event: {
      sessionId: SessionId
      goal?: { id: string; revision: number; activation: GoalActivation }
    }) => void): () => void {
      this.activationListeners.add(listener)
      return () => { this.activationListeners.delete(listener) }
    }

    emitActivation(
      sessionId: SessionId,
      goal: { id: string; revision: number; activation: GoalActivation } | undefined,
    ): void {
      for (const listener of this.activationListeners) {
        listener({ sessionId, ...goal === undefined ? {} : { goal } })
      }
    }
  }
  const remote = new RemoteService(ctx)
  ctx.provide('remote.goals', {
    get get() { return activeGoals?.get },
    get edit() { return activeGoals?.edit },
    get pause() { return activeGoals?.pause },
    get resume() { return activeGoals?.resume },
    get clear() { return activeGoals?.clear },
  })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: {
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const session = createSnapshotStore({ running: false })
  ctx.provide('sessions', {
    binding: (id: SessionId) => id !== sid('s1') ? undefined : ({
      sessionId: id,
      session: { ...session, projections: { faceOf: (key: string) => ({
        getSnapshot: () => (key === 'goal' ? options.projection : undefined),
        subscribe: () => () => {},
      }) } },
      ctx,
    }),
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    activationObserverCount: () => remote.activationListeners.size,
    emitActivation: remote.emitActivation.bind(remote),
    definitions: () => conversationEvents.entries(),
    remountGoals: () => { activeGoals = goals('remounted-goals') },
    unmountGoals: () => { activeGoals = undefined },
    entry: () => {
      const entry = ctx.slots.entries('conversation.input.dock')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => GoalBarInjected) | undefined,
      }
    },
    chatEntry: () => ctx.slots.entries('conversation.chat.node')[0],
  }
}

describe('ui-goal browser plugin', () => {
  it('registers the GoalBar dock, command input Definition, and keyed Chat renderer', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toMatchObject({ id: 'goal', order: 10, locale: 'goal' })
    expect(b.entry()?.inject).toBeTypeOf('function')
    expect(() => b.entry()!.inject!(sid('missing'))).toThrow(/unavailable/)
    expect(b.definitions().map(definition => definition.kind)).toEqual(['goal-command-input'])
    expect(b.chatEntry()?.options).toMatchObject({ key: 'command-input' })
    expect(b.chatEntry()?.locale).toBe('goal')
  })

  it('verbs read the CAS ref from the current projected value at call time', async () => {
    const b = await bench({ projection: makeProjection(5) })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    // The strip forwards the Remote value verbatim; `answered` is the fake's
    // reply, unrelated to the CAS ref the call carries.
    const answered = { id: 'g-1', revision: 3 }
    expect(await verbs.onEdit('New objective')).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onPause()).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onResume()).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onClear()).toEqual({ ok: true, value: answered })
    expect(b.calls.map(c => c.method)).toEqual(['goals/edit', 'goals/pause', 'goals/resume', 'goals/clear'])
    const ref = { id: 'g-1', revision: 5 }
    expect(b.calls[0]?.args).toEqual(['s1', ref, { objective: 'New objective' }])
    expect(b.calls[1]?.args).toEqual(['s1', ref])
    expect(b.calls[2]?.args).toEqual(['s1', ref])
    expect(b.calls[3]?.args).toEqual(['s1', ref])
  })

  it('verbs read a remounted Remote namespace at action time', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    b.remountGoals()

    expect(await verbs.onPause()).toEqual({ ok: true, value: { ref: { id: 'g-1', revision: 3 } } })
    expect(b.calls).toMatchObject([{ method: 'remounted-goals/pause' }])
  })

  it('binds the activation hook and forwards only this session activation events', async () => {
    const b = await bench({ projection: makeProjection(), activation: 'disarmed' })
    await b.fiber.await()
    const injected = b.entry()!.inject!(sid('s1'))
    const source = injected.hooks.goalActivation
    const seen: unknown[] = []
    const dispose = source.subscribe(() => { seen.push(source.getSnapshot()) })
    try {
      await waitFor(() => {
        expect(source.getSnapshot()).toMatchObject({ id: 'g-1', revision: 3, activation: 'disarmed' })
      })
      expect(b.calls.at(-1)).toMatchObject({ method: 'goals/get', args: ['s1'] })
      expect(b.activationObserverCount()).toBe(1)
      b.emitActivation(sid('s2'), { id: 'g-1', revision: 3, activation: 'armed' })
      expect(source.getSnapshot().activation).toBe('disarmed')
      b.emitActivation(sid('s1'), { id: 'g-1', revision: 3, activation: 'armed' })
      expect(source.getSnapshot().activation).toBe('armed')
      expect(seen.length).toBeGreaterThan(0)
    } finally {
      dispose()
      await b.ctx.fiber.dispose()
    }
    expect(b.activationObserverCount()).toBe(0)
  })

  it('rejects every verb once the Remote namespace is gone', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    b.unmountGoals()

    // A missing namespace is an assembly fault, not a call outcome: this plugin
    // declares remote.goals in `inject`, so cordis disposes the dock entry along
    // with the namespace. Only a React closure that outlived that disposal can
    // reach these verbs, so no consumer-side guard renders it as an error.
    for (const verb of [() => verbs.onEdit('x'), () => verbs.onPause(), () => verbs.onResume(), () => verbs.onClear()]) {
      await expect(verb()).rejects.toThrow(TypeError)
    }
    expect(b.calls).toHaveLength(0)
  })

  it('a null or absent projection short-circuits every verb without touching the wire', async () => {
    for (const projection of [null, undefined]) {
      const b = await bench({ projection })
      await b.fiber.await()
      const verbs = b.entry()!.inject!(sid('s1'))
      for (const result of [await verbs.onEdit('x'), await verbs.onPause(), await verbs.onResume(), await verbs.onClear()]) {
        expect(result).toEqual({ ok: false, error: { code: 'no-current-goal', message: 'no current goal to mutate' } })
      }
      expect(b.calls).toHaveLength(0)
    }
  })

  it('forwards a Remote failure to the strip verbatim', async () => {
    const b = await bench({ projection: makeProjection(), failWith: { code: 'internal', message: 'stale revision', details: {} } })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    expect(await verbs.onEdit('x')).toEqual({ ok: false, error: { code: 'internal', message: 'stale revision', details: {} } })
  })

  it('drops the dock entry when the plugin fiber unloads (HMR safety)', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toBeDefined()
    expect(b.chatEntry()).toBeDefined()
    expect(b.definitions()).toHaveLength(1)
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.chatEntry()).toBeUndefined()
    expect(b.definitions()).toHaveLength(0)
  })
})

describe('GoalDock adapter', () => {
  it('renders the projected goal snapshot and nothing for absent/null', () => {
    const projection = makeProjection()
    const useProjection = vi.fn(() => projection)
    const useGoalActivation = (
      selector: (snapshot: GoalActivationSnapshot) => unknown,
    ) => selector({ id: GOAL_ID, revision: 3, activation: 'armed' })
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true, value: undefined }),
      onPause: () => Promise.resolve({ ok: true, value: undefined }),
      onResume: () => Promise.resolve({ ok: true, value: undefined }),
      onClear: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const t = makeTranslate(zh, commonZh)
    const dockProps = (up: () => GoalProjection | null | undefined) =>
      ({ useProjection: up, useGoalActivation, ...actions, t }) as unknown as Parameters<typeof GoalDock>[0]
    const shown = render(<GoalDock {...dockProps(useProjection)} />)
    expect(shown.getByText('Ship it')).toBeTruthy()
    cleanup()

    const empty = render(<GoalDock {...dockProps(() => null)} />)
    expect(empty.container.firstChild).toBeNull()
    cleanup()

    const absent = render(<GoalDock {...dockProps(() => undefined)} />)
    expect(absent.container.firstChild).toBeNull()
  })

  it('matches activation by goal id and revision from the injected hook', () => {
    const projection = makeProjection()
    const useProjection = vi.fn(() => projection)
    const useGoalActivation = (
      selector: (snapshot: GoalActivationSnapshot) => unknown,
    ) => selector({ id: GOAL_ID, revision: 3, activation: 'disarmed' })
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true, value: undefined }),
      onPause: () => Promise.resolve({ ok: true, value: undefined }),
      onResume: () => Promise.resolve({ ok: true, value: undefined }),
      onClear: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const t = makeTranslate(zh, commonZh)
    const props = { useProjection, useGoalActivation, ...actions, t } as unknown as Parameters<typeof GoalDock>[0]
    const rendered = render(<GoalDock {...props} />)
    expect(rendered.getByText('未运行的目标')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复目标' })).toBeTruthy()
    expect(rendered.queryByRole('button', { name: '暂停目标' })).toBeNull()
  })

  it.each([
    { id: 'other' as GoalId, revision: 3 },
    { id: GOAL_ID, revision: 2 },
  ])('withholds resume for a different ref %j while preserving pause', (ref) => {
    const source = createSnapshotStore<GoalActivationSnapshot>({ ...ref, activation: 'armed' })
    const snapshot: ConversationSnapshot = {
      sessionId: sid('goal-session'), views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
      nodes: [], turnTimings: new Map(), turnEnds: new Map(), openTurn: undefined, partial: null,
      runningCalls: [], pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
      openState: 'open', openError: null, hasMore: true, loadingOlder: false,
      historyWindowMode: 'tail', historyDetail: 'full', promptError: null, blank: false,
      subagent: null, lastAgentError: null,
    }
    const props: Parameters<typeof GoalDock>[0] = {
      useProjection: () => makeProjection(),
      useGoalActivation: bindSnapshotSelector(source),
      onEdit: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onClear: vi.fn(),
      t: makeTranslate(zh, commonZh),
      session: snapshot,
      input: { draft: '', imageIds: [], documentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] },
      sessionId: sid('goal-session'),
      useSession: bindSnapshotSelector(createSnapshotStore(snapshot)),
      useSessions: () => { throw new Error('unused') },
      useWorkspaces: () => { throw new Error('unused') },
      usePanelInfo: () => { throw new Error('unused') },
      useInput: () => { throw new Error('unused') },
      inputActions: {
        setDraft: () => {}, addImages: () => true, removeImage: () => {},
        pruneImages: () => {}, addDocuments: () => true, removeDocument: () => {},
        pruneDocuments: () => {}, captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
        insertText: () => false, submit: () => {},
      },
    }
    render(<GoalDock {...props} />)
    expect(screen.getByRole('button', { name: '暂停目标' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复目标' })).toBeNull()
    act(() => { source.set({ id: GOAL_ID, revision: 3, activation: 'disarmed' }) })
    expect(screen.getByRole('button', { name: '恢复目标' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '暂停目标' })).toBeNull()
  })
})

describe('ui-goal node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
