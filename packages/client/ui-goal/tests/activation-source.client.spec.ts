import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { GoalActivationChanged, GoalId, GoalProjection, GoalView } from '@deepseek-ai/dsh-goal/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createGoalActivationSource } from '../src/client/activation-source.ts'

const GOAL_ID = 'g-1' as GoalId

function projection(): GoalProjection {
  return {
    goal: {
      id: GOAL_ID,
      revision: 1,
      objective: 'ship it',
      phase: 'active',
      maxGoalRounds: 8,
    },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function goalView(activation: 'armed' | 'disarmed'): GoalView {
  return { ...projection().goal, roundsStarted: 0, createdAt: 1, updatedAt: 1, activation }
}

describe('goal activation source', () => {
  it.each(['resolve', 'reject'] as const)('ignores a late %s after the last observer leaves', async (settlement) => {
    const read = Promise.withResolvers<RemoteResult<GoalView | undefined>>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const changed = vi.fn()
    const source = createGoalActivationSource({
      projection: createSnapshotStore(projection()),
      session: createSnapshotStore({ running: false }),
      getGoal: () => read.promise,
      subscribeActivation: () => () => {},
      subscribeReset: () => () => {},
    })
    const dispose = source.subscribe(changed)
    const before = source.getSnapshot()
    dispose()
    changed.mockClear()
    try {
      if (settlement === 'resolve') read.resolve({ ok: true, value: goalView('armed') })
      else read.reject(new Error('late read'))
      await read.promise.then(() => undefined, () => undefined)
      expect(source.getSnapshot()).toBe(before)
      expect(changed).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('contains a current read rejection and retains the goal ref', async () => {
    const read = Promise.withResolvers<RemoteResult<GoalView | undefined>>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = createGoalActivationSource({
      projection: createSnapshotStore(projection()),
      session: createSnapshotStore({ running: false }),
      getGoal: () => read.promise,
      subscribeActivation: () => () => {},
      subscribeReset: () => () => {},
    })
    const dispose = source.subscribe(() => {})
    try {
      const error = new Error('offline')
      read.reject(error)
      await read.promise.catch(() => undefined)
      expect(warn).toHaveBeenCalledExactlyOnceWith('[ui-goal] goal activation read failed:', error)
      expect(source.getSnapshot()).toEqual({ id: GOAL_ID, revision: 1 })
    } finally {
      dispose()
      warn.mockRestore()
    }
  })

  it('keeps a newer projected revision when the previous revision read settles', async () => {
    const projectionStore = createSnapshotStore(projection())
    const first = Promise.withResolvers<RemoteResult<GoalView | undefined>>()
    const second = Promise.withResolvers<RemoteResult<GoalView | undefined>>()
    const getGoal = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const source = createGoalActivationSource({
      projection: projectionStore,
      session: createSnapshotStore({ running: false }),
      getGoal,
      subscribeActivation: () => () => {},
      subscribeReset: () => () => {},
    })
    const dispose = source.subscribe(() => {})
    try {
      const next = projection()
      projectionStore.set({ ...next, goal: { ...next.goal, revision: 2 } })
      expect(getGoal).toHaveBeenCalledTimes(2)
      first.resolve({ ok: true, value: goalView('armed') })
      await first.promise
      expect(source.getSnapshot()).toEqual({ id: GOAL_ID, revision: 2 })
      second.resolve({ ok: true, value: { ...goalView('disarmed'), revision: 2 } })
      await second.promise
      expect(source.getSnapshot()).toEqual({ id: GOAL_ID, revision: 2, activation: 'disarmed' })
    } finally {
      dispose()
      first.resolve({ ok: true, value: undefined })
      second.resolve({ ok: true, value: undefined })
      await Promise.all([first.promise, second.promise])
    }
  })

  it('does not let a stale read overwrite a later activation event', async () => {
    const projectionStore = createSnapshotStore<GoalProjection | null | undefined>(projection())
    const session = createSnapshotStore({ running: false })
    let resolveRead!: (value: RemoteResult<GoalView | undefined>) => void
    const getGoal = vi.fn(() => new Promise<RemoteResult<GoalView | undefined>>((resolve) => {
      resolveRead = resolve
    }))
    let activationListener: ((goal: GoalActivationChanged['goal']) => void) | undefined
    const source = createGoalActivationSource({
      projection: projectionStore,
      session,
      getGoal,
      subscribeActivation: (listener) => {
        activationListener = listener
        return () => { activationListener = undefined }
      },
      subscribeReset: () => () => {},
    })
    const dispose = source.subscribe(() => {})

    activationListener?.({ id: GOAL_ID, revision: 1, activation: 'disarmed' })
    resolveRead({ ok: true, value: goalView('armed') })
    await Promise.resolve()

    expect(source.getSnapshot()).toMatchObject({ id: 'g-1', revision: 1, activation: 'disarmed' })
    dispose()
  })

  it('refreshes on the running edge without clearing the last activation', async () => {
    const projectionStore = createSnapshotStore<GoalProjection | null | undefined>(projection())
    const session = createSnapshotStore({ running: false })
    const getGoal = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: goalView('disarmed') })
      .mockImplementationOnce(() => new Promise<RemoteResult<GoalView | undefined>>(() => {}))
    const source = createGoalActivationSource({
      projection: projectionStore,
      session,
      getGoal,
      subscribeActivation: () => () => {},
      subscribeReset: () => () => {},
    })
    const dispose = source.subscribe(() => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(source.getSnapshot().activation).toBe('disarmed')

    session.set({ running: true })
    expect(source.getSnapshot().activation).toBe('disarmed')
    dispose()
  })

  it('merges lifecycle edges and releases subscriptions with the last observer', async () => {
    const projectionStore = createSnapshotStore<GoalProjection | null | undefined>(projection())
    const session = createSnapshotStore({ running: false })
    const getGoal = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: goalView('armed'),
    }))
    let emitActivation: ((goal: GoalActivationChanged['goal']) => void) | undefined
    let emitReset: (() => void) | undefined
    const disposeProjection: Array<() => void> = []
    const disposeSession: Array<() => void> = []
    const source = createGoalActivationSource({
      projection: {
        getSnapshot: () => projectionStore.getSnapshot(),
        subscribe: (listener) => {
          disposeProjection.push(listener)
          return projectionStore.subscribe(listener)
        },
      },
      session: {
        getSnapshot: () => session.getSnapshot(),
        subscribe: (listener) => {
          disposeSession.push(listener)
          return session.subscribe(listener)
        },
      },
      getGoal,
      subscribeActivation: (listener) => {
        emitActivation = listener
        return () => { emitActivation = undefined }
      },
      subscribeReset: (listener) => {
        emitReset = listener
        return () => { emitReset = undefined }
      },
    })

    const first = source.subscribe(() => {})
    const second = source.subscribe(() => {})
    emitActivation?.({ id: GOAL_ID, revision: 1, activation: 'disarmed' })
    emitActivation?.({ id: GOAL_ID, revision: 1, activation: 'disarmed' })
    emitActivation?.(undefined)
    emitActivation?.({ id: GOAL_ID, revision: 1, activation: 'armed' })
    projectionStore.set(null)
    session.set({ running: false })
    session.set({ running: true })
    await Promise.resolve()
    emitReset?.()
    await Promise.resolve()
    projectionStore.set(projection())
    await Promise.resolve()

    expect(source.getSnapshot()).toMatchObject({ id: 'g-1', revision: 1, activation: 'armed' })
    expect(disposeProjection.length).toBeGreaterThan(0)
    expect(disposeSession.length).toBeGreaterThan(0)
    first()
    expect(emitActivation).toBeDefined()
    second()
    expect(emitActivation).toBeUndefined()
    expect(emitReset).toBeUndefined()
  })

  it.each(['connection reset', 'observer restart'] as const)(
    'clears stale activation on %s even when the new read fails',
    async (edge) => {
      const initial = Promise.resolve<RemoteResult<GoalView | undefined>>({ ok: true, value: goalView('armed') })
      const retry = Promise.withResolvers<RemoteResult<GoalView | undefined>>()
      const getGoal = vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(retry.promise)
      let reset: (() => void) | undefined
      const source = createGoalActivationSource({
        projection: createSnapshotStore(projection()),
        session: createSnapshotStore({ running: false }),
        getGoal,
        subscribeActivation: () => () => {},
        subscribeReset: (listener) => {
          reset = listener
          return () => { reset = undefined }
        },
      })
      let dispose = source.subscribe(() => {})
      try {
        await initial
        expect(source.getSnapshot().activation).toBe('armed')
        if (edge === 'connection reset') reset?.()
        else {
          dispose()
          dispose = source.subscribe(() => {})
        }
        expect(getGoal).toHaveBeenCalledTimes(2)
        expect(source.getSnapshot()).toEqual({ id: GOAL_ID, revision: 1 })
        retry.resolve({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
        await retry.promise
        expect(source.getSnapshot()).toEqual({ id: GOAL_ID, revision: 1 })
      } finally {
        dispose()
        retry.resolve({ ok: true, value: undefined })
        await retry.promise
      }
    },
  )

  it('retains the ref with unknown activation when an authoritative read fails', async () => {
    const projectionStore = createSnapshotStore<GoalProjection | null | undefined>(projection())
    const session = createSnapshotStore({ running: false })
    const source = createGoalActivationSource({
      projection: projectionStore,
      session,
      getGoal: () => Promise.resolve({
        ok: false,
        error: new RemoteError('gateway/internal', 'no', {}),
      }),
      subscribeActivation: () => () => {},
      subscribeReset: () => () => {},
    })
    const dispose = source.subscribe(() => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(source.getSnapshot()).toMatchObject({ id: 'g-1', revision: 1 })
    expect(source.getSnapshot().activation).toBeUndefined()
    dispose()
  })

  it('does not republish an unchanged active ref or an already-empty projection', async () => {
    const emptyProjection = createSnapshotStore<GoalProjection | null | undefined>(null)
    const emptySession = createSnapshotStore({ running: false })
    const emptySource = createGoalActivationSource({
      projection: emptyProjection,
      session: emptySession,
      getGoal: () => Promise.resolve({ ok: true, value: undefined }),
      subscribeActivation: () => () => {},
      subscribeReset: () => () => {},
    })
    const emptyDispose = emptySource.subscribe(() => {})
    expect(emptySource.getSnapshot()).toEqual({})
    emptyDispose()

    const projectionStore = createSnapshotStore<GoalProjection | null | undefined>(projection())
    const session = createSnapshotStore({ running: false })
    const source = createGoalActivationSource({
      projection: projectionStore,
      session,
      getGoal: () => Promise.resolve({ ok: true, value: goalView('armed') }),
      subscribeActivation: () => () => {},
      subscribeReset: () => () => {},
    })
    const dispose = source.subscribe(() => {})
    await Promise.resolve()
    await Promise.resolve()
    let notifications = 0
    const disposeObserver = source.subscribe(() => { notifications++ })
    projectionStore.set(projection())
    await Promise.resolve()
    expect(notifications).toBe(0)
    expect(source.getSnapshot()).toMatchObject({ id: 'g-1', revision: 1, activation: 'armed' })
    disposeObserver()
    dispose()
  })
})
