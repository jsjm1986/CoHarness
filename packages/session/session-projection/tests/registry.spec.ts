/**
 * SessionProjectionRegistry unit drive: eager apply on committed events with
 * lazy cell build (registration after events, session after registration),
 * the Object.is no-change gate (same reference ⇒ zero change-feed work),
 * snapshot consistency (asOfSeq = last event seq; values from the watermark
 * cache), duplicate-key rejection, stateVersion validation, the per-event
 * change frame feed, and effect-tied removal of registrations and change
 * listeners (HMR safety).
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/marks': MarksState
    'test/count': number
    'test/stable-view': StableViewState
    'test/cut': number
  }

  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
    'test/stable-view': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/mark': { marks: string[] }
  }
}

interface MarksView {
  marks: string[]
}
type MarksState = MarksView | null
interface StableViewState {
  revision: number
  value: MarksView
}
const RESTORE_HEADER: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('projection-restore'),
  createdAt: 0,
  isSeeded: false,
}
/** Whole-value unit: latest test/mark event wins; unrelated events return the same reference. */
const marksUnit = (): Omit<ProjectionDefinition<'test/marks', MarksState>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'test/marks', MarksState>['wire']> } => ({
  key: 'test/marks',
  stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'test/mark' ? (event).data : state),
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view: state => state ?? { marks: [] },
  },
  stateVersion: 1,
})

/** Host-only counting unit over every event — state changes on each apply. */
const countUnit = (): ProjectionDefinition<'test/count', number> => ({
  key: 'test/count',
  stateSchema: z.number().int().nonnegative(),
  init: () => 0,
  apply: state => state + 1,
  stateVersion: 1,
})

/** State changes on every matching event while the wire view may reuse one reference. */
const stableViewUnit = (
  view: (state: StableViewState) => StableViewState['value'],
) => ({
  key: 'test/stable-view',
  stateSchema: z.object({
    revision: z.number().int().nonnegative(),
    value: z.object({ marks: z.array(z.string()) }),
  }),
  init: () => ({ revision: 0, value: { marks: [] } }),
  apply: (state, event) => {
    if (event.type === 'turn/start') return { ...state, revision: state.revision + 1 }
    if (event.type === 'test/mark') return { revision: state.revision + 1, value: event.data }
    return state
  },
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/stable-view', StableViewState>

/** Host-only unit whose initial state proves the exact inherited cut. */
async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('test/mark', { marks })

describe('SessionProjectionRegistry drive', () => {
  it('drives a registered unit over committed events and snapshots the current value', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    mark(session, ['a', 'b'])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['a', 'b'] })
    expect(snapshot.asOfSeq).toBe(session.seq - 1)
  })

  it('builds the cell lazily from the full log for a unit registered after events flowed', async () => {
    const { ctx, session } = await harness()
    mark(session, ['pre-registration'])
    ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['pre-registration'] })
    // The lazily-built cell then continues on the live drive path.
    mark(session, ['after'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['after'] })
  })

  it('advances an already materialized cell across detached appends', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.prepare('detached-append' as never)
    ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: [] })
    // Detached Sessions do not publish session/event; the next read must still
    // notice their appended suffix rather than serving the stale cell.
    mark(session, ['detached-append'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['detached-append'] })
  })

  it('serves init-derived state and asOfSeq -1 for an empty log', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.asOfSeq).toBe(-1)
    expect(snapshot.values['test/marks']).toEqual({ marks: [] })
  })

  it('notifies onChanged with the validated view and the causing seq, and skips same-reference applies', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const seen: { key: string; value: unknown; seq: SessionSeq; sessionId: string }[] = []
    ctx.sessionProjections.onChanged((changedSession, key, value, seq) => {
      seen.push({ key, value, seq, sessionId: String(changedSession.id) })
    })
    const event = mark(session, ['a'])
    // Non-matching event: apply returns the same reference — no notification.
    session.append('turn/start', { turn: 1 })
    expect(seen).toEqual([{ key: 'test/marks', value: { marks: ['a'] }, seq: event.seq, sessionId: String(session.id) }])
  })

  it('suppresses a live notification when a changed state keeps the same raw view reference', async () => {
    const { ctx, session } = await harness()
    const visible = { marks: ['stable'] }
    ctx.sessionProjections.register(stableViewUnit(() => visible))
    const seen: number[] = []
    ctx.sessionProjections.onChanged((_session, _key, _value, seq) => { seen.push(seq) })
    mark(session, ['first'])
    mark(session, ['second'])
    expect(seen).toEqual([0])
    expect(ctx.sessionProjections.snapshot(session).values['test/stable-view']).toEqual({ marks: ['stable'] })
  })

  it('notifies onEventChanged once per event with every changed key in registration order', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    // A distinct but reference-stable view, so the two entries carry different values.
    const upper = new WeakMap<MarksView, MarksView>()
    ctx.sessionProjections.register(stableViewUnit((state) => {
      const cached = upper.get(state.value)
      if (cached !== undefined) return cached
      const view = { marks: state.value.marks.map(item => item.toUpperCase()) }
      upper.set(state.value, view)
      return view
    }))
    const order: string[] = []
    const events: { changes: readonly { key: string; val: unknown }[]; seq: SessionSeq; sessionId: string }[] = []
    ctx.sessionProjections.onChanged((_session, key) => { order.push(`key:${key}`) })
    ctx.sessionProjections.onEventChanged((changedSession, changes, seq) => {
      order.push('event')
      events.push({ changes, seq, sessionId: String(changedSession.id) })
    })

    const event = mark(session, ['a'])
    // Host-only and unchanged-view state changes publish nothing.
    session.append('turn/start', { turn: 1 })

    expect(events).toEqual([{
      changes: [{ key: 'test/marks', val: { marks: ['a'] } }, { key: 'test/stable-view', val: { marks: ['A'] } }],
      seq: event.seq,
      sessionId: String(session.id),
    }])
    expect(order).toEqual(['key:test/marks', 'key:test/stable-view', 'event'])
  })

  it('still delivers the changes made before a later unit throws', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    // A fresh invalid view on every change: its schema parse throws after test/marks was collected.
    ctx.sessionProjections.register(stableViewUnit(() => ({ marks: 1 }) as never))
    const events: { changes: readonly { key: string; val: unknown }[]; seq: SessionSeq }[] = []
    ctx.sessionProjections.onEventChanged((_session, changes, seq) => {
      events.push({ changes, seq })
    })

    const event = mark(session, ['a'])

    expect(events).toEqual([{ changes: [{ key: 'test/marks', val: { marks: ['a'] } }], seq: event.seq }])
  })

  it('computes views for an event listener alone and stops after its disposer runs', async () => {
    const { ctx, session } = await harness()
    const view = vi.fn((state: StableViewState) => state.value)
    ctx.sessionProjections.register(stableViewUnit(view))
    const seen: { keys: readonly string[]; seq: SessionSeq }[] = []
    const stop = ctx.sessionProjections.onEventChanged((_session, changes, seq) => {
      seen.push({ keys: changes.map(change => change.key), seq })
    })

    const event = session.append('turn/start', { turn: 1 })
    expect(view).toHaveBeenCalledOnce()
    expect(seen).toEqual([{ keys: ['test/stable-view'], seq: event.seq }])

    stop()
    mark(session, ['after-stop'])
    expect(seen).toHaveLength(1)
    expect(view).toHaveBeenCalledOnce()
  })

  it('publishes the first frame after a listener gap drops the comparison baseline', async () => {
    const { ctx, session } = await harness()
    const view = vi.fn((state: StableViewState) => state.value)
    ctx.sessionProjections.register(stableViewUnit(view))
    const collect = (frames: { changes: readonly { key: string; val: unknown }[] }[]) =>
      ctx.sessionProjections.onEventChanged((_session, changes) => {
        frames.push({ changes })
      })
    const first: { changes: readonly { key: string; val: unknown }[] }[] = []
    const stop = collect(first)

    session.append('turn/start', { turn: 1 })
    stop()
    session.append('turn/start', { turn: 2 })
    expect(view).toHaveBeenCalledOnce()

    const resumed: { changes: readonly { key: string; val: unknown }[] }[] = []
    collect(resumed)
    session.append('turn/start', { turn: 3 })

    expect(first).toEqual([{ changes: [{ key: 'test/stable-view', val: { marks: [] } }] }])
    expect(resumed).toEqual([{ changes: [{ key: 'test/stable-view', val: { marks: [] } }] }])
    expect(view).toHaveBeenCalledTimes(2)
  })

  it('removes event-level change listeners when their owning fiber unloads (HMR safety)', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const notifications: (readonly string[])[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.onEventChanged((_session, changes) => {
        notifications.push(changes.map(change => change.key))
      })
    }, { inject: ['sessionProjections'] }))
    mark(session, ['live'])
    await fiber.dispose()
    mark(session, ['after-dispose'])
    expect(notifications).toEqual([['test/marks']])
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/marks': { marks: ['after-dispose'] } })
  })

  it('does not compute a view while no change listener exists', async () => {
    const { ctx, session } = await harness()
    const view = vi.fn((state: StableViewState) => state.value)
    ctx.sessionProjections.register(stableViewUnit(view))

    session.append('turn/start', { turn: 1 })
    session.append('turn/start', { turn: 2 })

    expect(ctx.sessionProjections.stateOf(session, 'test/stable-view')?.revision).toBe(2)
    expect(view).not.toHaveBeenCalled()
  })

  it('drives independently per session (cells are per-session watermarks)', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['one'])
    mark(other, ['two'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['one'] })
    expect(ctx.sessionProjections.snapshot(other).values['test/marks']).toEqual({ marks: ['two'] })
  })

  it('updates host-only units without publishing them to wire listeners', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const changedKeys: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => {
      changedKeys.push(key)
    })
    session.append('turn/start', { turn: 1 })
    expect(changedKeys).toEqual([])
    expect(ctx.sessionProjections.stateOf(session, 'test/count')).toBe(1)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/marks': { marks: [] } })
  })

  it('shares one unit between registrants of the same key', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())

    // One definition already serves every session (cells are keyed by
    // Session), and registrants are per-session now: an agent preset mounts
    // the same tool package once per agent.
    expect(() => ctx.sessionProjections.register(marksUnit())).not.toThrow()
    mark(session, ['kept'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
  })

  it('increments the registration revision only when a key enters or leaves', async () => {
    const { ctx } = await harness()
    expect(ctx.sessionProjections.revision).toBe(0)
    const first = ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.revision).toBe(1)
    const second = ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.revision).toBe(1)
    first()
    expect(ctx.sessionProjections.revision).toBe(1)
    second()
    expect(ctx.sessionProjections.revision).toBe(2)
  })

  it('keeps the unit until the last registrant releases it', async () => {
    const { ctx, session } = await harness()
    const first = ctx.sessionProjections.register(marksUnit())
    const second = ctx.sessionProjections.register(marksUnit())
    mark(session, ['kept'])

    first()

    // The regression this counts against: one session ending used to strip
    // the projection from every other live session, because the first
    // registrant owned the only disposer.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
    second()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('refuses to share a key across a stateVersion change', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())

    // The one incompatibility a runtime comparison can name: the versioned
    // contract says the cached state shape differs, so the two cannot share
    // cells. Everything else about a definition is functions.
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 9 }))
      .toThrow(/already registered at stateVersion 1; refusing to share it with stateVersion 9/)
  })

  it('rejects a non-integer or negative stateVersion at register time', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: -1 })).toThrow(/stateVersion/)
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 1.5 })).toThrow(/stateVersion/)
  })

  it('register() disposer removes the key (with its cells) and frees it for re-registration', async () => {
    const { ctx, session } = await harness()
    const dispose = ctx.sessionProjections.register(marksUnit())
    mark(session, ['cached'])
    dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    ctx.sessionProjections.register(marksUnit())
    // Fresh registration rebuilds from the log, not from a stale cell.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['cached'] })
  })

  it('freezes a released unit: checkpoints keep its last cell while every live face skips it', async () => {
    const { ctx, session } = await harness()
    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      inner.sessionProjections.register(marksUnit())
    }, { inject: ['sessionProjections'] }))
    ctx.sessionProjections.register(countUnit())
    const released = mark(session, ['released'])
    await owner.dispose()

    const after = mark(session, ['after'])
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    expect(ctx.sessionProjections.stateOf(session, 'test/marks')).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(session, 'test/count')).toBe(2)
    // No drive, snapshot, or materializing read advanced the released cell.
    const rows = ctx.sessionProjections.checkpoint(session)
    expect(rows).toEqual({
      'test/marks': { ver: 1, seq: released.seq, val: { marks: ['released'] } },
      'test/count': { ver: 1, seq: after.seq, val: 2 },
    })
    // A Session created after the release never gets a cell for the unit.
    const fresh = ctx.sessions.create()
    expect(ctx.sessionProjections.checkpoint(fresh)).toEqual({ 'test/count': { ver: 1, seq: -1, val: 0 } })

    // Restore paths consult only live units, so the frozen row neither lowers the floor nor gets viewed.
    expect(ctx.sessionProjections.restoreFloor(rows)).toBe(SessionLogOffset(after.seq))
    expect(ctx.sessionProjections.viewCheckpoint(rows)).toEqual({})
    const events = [released, after]
    expect(ctx.sessionProjections.restore(rows, events, SessionLogOffset(0), RESTORE_HEADER, SessionLogOffset(0))).toEqual({
      snapshot: { asOfSeq: after.seq, values: {} },
      checkpoint: { 'test/count': { ver: 1, seq: after.seq, val: 2 } },
    })
    const prepared = ctx.sessions.prepare(SessionId('projection-hydrate-released'), { seed: events })
    const hydrated = ctx.sessionProjections.hydrate(prepared, rows, events, SessionLogOffset(0))
    expect(hydrated).toEqual({ asOfSeq: after.seq, values: {} })
    expect(ctx.sessionProjections.hydrate(prepared, rows, events, SessionLogOffset(0))).toEqual(hydrated)
    expect(ctx.sessionProjections.checkpoint(prepared)).not.toHaveProperty('test/marks')
  })

  it('re-registering a released key refolds the Session instead of continuing the frozen cell', async () => {
    const { ctx, session } = await harness()
    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      inner.sessionProjections.register(marksUnit())
    }, { inject: ['sessionProjections'] }))
    const released = mark(session, ['released'])
    await owner.dispose()
    const after = mark(session, ['after'])
    expect(ctx.sessionProjections.checkpoint(session)['test/marks'])
      .toEqual({ ver: 1, seq: released.seq, val: { marks: ['released'] } })

    ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.stateOf(session, 'test/marks')).toEqual({ marks: ['after'] })
    expect(ctx.sessionProjections.checkpoint(session)['test/marks'])
      .toEqual({ ver: 1, seq: after.seq, val: { marks: ['after'] } })
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['after'] })
  })

  it('removes registrations and change listeners when their owning fiber unloads (HMR safety)', async () => {
    const { ctx, session } = await harness()
    const notifications: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.register(marksUnit())
      inner.sessionProjections.onChanged((_session, key) => {
        notifications.push(key)
      })
    }, { inject: ['sessionProjections'] }))
    mark(session, ['live'])
    expect(notifications).toEqual(['test/marks'])
    await fiber.dispose()
    mark(session, ['after-dispose'])
    expect(notifications).toEqual(['test/marks'])
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('keeps a yielded registration live until the composite finishes using it', async () => {
    const { ctx, session } = await harness()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    let observed: MarksState | undefined
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.effect(function* () {
        yield inner.sessionProjections.register(marksUnit())
        yield () => { observed = inner.sessionProjections.stateOf(session, 'test/marks') }
      })
    }, { inject: ['sessionProjections'] }))
    mark(session, ['live'])
    await fiber.dispose()
    expect(observed).toEqual({ marks: ['live'] })
    expect(ctx.sessionProjections.stateOf(session, 'test/marks')).toBeUndefined()
  })

  it('snapshot serves client views and excludes host-only state', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    mark(session, ['a', 'b'])
    const values = ctx.sessionProjections.snapshot(session).values
    expect(values['test/marks']).toEqual({ marks: ['a', 'b'] })
    expect('test/count' in values).toBe(false)
    expect(ctx.sessionProjections.stateOf(session, 'test/count')).toBe(1)
    expect('test/unregistered' in values).toBe(false)
  })

  it('checkpoints every persisted unit with its stateVersion and per-cell watermark', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register({ ...countUnit(), stateVersion: 7 })
    const markEvent = mark(session, ['a'])
    const rows = ctx.sessionProjections.checkpoint(session)
    expect(rows['test/marks']).toEqual({ ver: 1, seq: markEvent.seq, val: { marks: ['a'] } })
    expect(rows['test/count']).toEqual({ ver: 7, seq: markEvent.seq, val: 1 })
    // Empty log: init-derived state at watermark -1.
    const fresh = ctx.sessions.create()
    expect(ctx.sessionProjections.checkpoint(fresh)['test/marks']).toEqual({ ver: 1, seq: -1, val: null })
  })

  it('checkpoint states are detached clones — mutating them cannot corrupt the watermark cache', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    const rows = ctx.sessionProjections.checkpoint(session)
    // Hostile (or merely careless) consumer mutates the handed-out state.
    ;(rows['test/marks']?.val as { marks: string[] }).marks.push('INJECTED')
    // The registry's authoritative cell is untouched: snapshot and a fresh
    // checkpoint both still serve the committed value.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['a'] })
    expect(ctx.sessionProjections.checkpoint(session)['test/marks']?.val).toEqual({ marks: ['a'] })
  })

  it('restoreFloor anchors one below the lowest usable watermark and at 0 for missing or mismatched rows', async () => {
    const { ctx } = await harness()
    expect(ctx.sessionProjections.restoreFloor({})).toBeUndefined() // no unit registered
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    expect(ctx.sessionProjections.restoreFloor({})).toBe(0)
    // Lowest usable watermark is count's 5 → the anchored tail starts AT 5
    // (one below the first needed seq 6), so the read proves seq 5 still exists.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 1, seq: SessionSeq(10), val: { marks: [] } },
      'test/count': { ver: 1, seq: SessionSeq(5), val: 6 },
    })).toBe(5)
    // A version-mismatched row forces that key back to a full refold.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 2, seq: SessionSeq(10), val: { marks: [] } },
      'test/count': { ver: 1, seq: SessionSeq(5), val: 6 },
    })).toBe(0)
    // A fresh (-1) row still needs the whole tail from 0.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 1, seq: -1, val: null },
      'test/count': { ver: 1, seq: -1, val: 0 },
    })).toBe(0)
  })

  it('restore folds the tail past each usable row and refolds from init on version mismatch', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const tail: SessionEvent[] = [
      { type: 'test/mark', seq: SessionSeq(3), time: 3, data: { marks: ['new'] } },
      { type: 'turn/end', seq: SessionSeq(4), time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    // marks row usable (watermark 2, tail starts at 3); count row mismatched — but
    // a mismatch with baseSeq > 0 cannot silently refold: it throws for a re-read.
    expect(() => ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: SessionSeq(2), val: { marks: ['old'] } },
      'test/count': { ver: 99, seq: SessionSeq(2), val: 3 },
    }, tail, SessionLogOffset(3), RESTORE_HEADER, SessionLogOffset(0)))
      .toThrow(/re-read from seq 0/)
    // The full-log re-read (baseSeq 0) refolds the mismatched key from init.
    const full: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      { type: 'test/mark', seq: SessionSeq(1), time: 1, data: { marks: ['old'] } },
      { type: 'test/mark', seq: SessionSeq(2), time: 2, data: { marks: ['old', '2'] } },
      ...tail,
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: SessionSeq(2), val: { marks: ['old', '2'] } },
      'test/count': { ver: 99, seq: SessionSeq(2), val: 3 },
    }, full, SessionLogOffset(0), RESTORE_HEADER, SessionLogOffset(0))
    expect(snapshot.asOfSeq).toBe(4)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['new'] })
    expect('test/count' in snapshot.values).toBe(false)
    // The refreshed rows sit at the served cut, ready for a durable write-back.
    expect(checkpoint['test/marks']).toEqual({ ver: 1, seq: 4, val: { marks: ['new'] } })
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
  })

  it('restore over a suffix folds only past each row watermark and serves an exact empty-tail cut', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const rows = {
      'test/marks': { ver: 1, seq: SessionSeq(4), val: { marks: ['done'] } },
      'test/count': { ver: 1, seq: SessionSeq(2), val: 3 },
    }
    const tail: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(3), time: 3, data: { turn: 2 } },
      { type: 'turn/end', seq: SessionSeq(4), time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore(
      rows,
      tail,
      SessionLogOffset(3),
      RESTORE_HEADER,
      SessionLogOffset(0),
    )
    expect(snapshot.asOfSeq).toBe(4)
    // marks already covers the tail (watermark 4): nothing re-applied.
    expect(snapshot.values['test/marks']).toEqual({ marks: ['done'] })
    // count folds exactly seqs 3 and 4 on top of its checkpoint, but remains host-only.
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
    expect('test/count' in snapshot.values).toBe(false)

    // Empty tail (checkpoint is current): the cut sits at baseSeq - 1.
    const { snapshot: current, checkpoint: currentCheckpoint } = ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: SessionSeq(4), val: { marks: ['done'] } },
      'test/count': { ver: 1, seq: SessionSeq(4), val: 5 },
    }, [], SessionLogOffset(5), RESTORE_HEADER, SessionLogOffset(0))
    expect(current.asOfSeq).toBe(4)
    expect('test/count' in current.values).toBe(false)
    expect(currentCheckpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
  })

  it('viewCheckpoint serves version-matching rows without any log and skips mismatched keys', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const values = ctx.sessionProjections.viewCheckpoint({
      'test/marks': { ver: 1, seq: SessionSeq(4), val: { marks: ['stored'] } },
      'test/count': { ver: 99, seq: SessionSeq(4), val: 5 }, // mismatched: absent
    })
    expect(values['test/marks']).toEqual({ marks: ['stored'] })
    expect('test/count' in values).toBe(false)
    expect(ctx.sessionProjections.viewCheckpoint({})).toEqual({})
  })

  it('viewCheckpoint and restore exclude host-only state while retaining its checkpoint', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const rows = {
      'test/marks': { ver: 1, seq: SessionSeq(4), val: { marks: ['stored'] } },
      'test/count': { ver: 1, seq: SessionSeq(4), val: 5 },
    }
    expect(ctx.sessionProjections.viewCheckpoint(rows)).toEqual({
      'test/marks': { marks: ['stored'] },
    })

    const restored = ctx.sessionProjections.restore(
      rows,
      [],
      SessionLogOffset(5),
      RESTORE_HEADER,
      SessionLogOffset(0),
    )
    expect(restored.snapshot.values).toEqual({
      'test/marks': { marks: ['stored'] },
    })
    expect(restored.checkpoint['test/count']).toEqual(rows['test/count'])
  })

  it('rejects version-matching rows whose state no longer matches the registered schema', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const drifted = {
      'test/marks': { ver: 1, seq: SessionSeq(2), val: { marks: 'not-an-array' } },
    }

    expect(ctx.sessionProjections.viewCheckpoint(drifted)).toEqual({})
    expect(() => ctx.sessionProjections.restore(
      drifted,
      [],
      SessionLogOffset(3),
      RESTORE_HEADER,
      SessionLogOffset(0),
    )).toThrow()
  })

  it('restore rejects a row claiming events past the supplied log end (shrunk log ⇒ re-read)', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(countUnit())
    const rows = { 'test/count': { ver: 1, seq: SessionSeq(9), val: 10 } }
    // The anchored floor sits ON the watermark, so the tail read must return
    // at least seq 9 from an intact log…
    const floor = ctx.sessionProjections.restoreFloor(rows)
    expect(floor).toBe(9)
    // …an intact log serves the anchor event and the checkpoint stands as-is.
    const anchor: SessionEvent = { type: 'turn/end', seq: SessionSeq(9), time: 9, data: { turn: 2, reason: { kind: 'completed' } } }
    const anchored = ctx.sessionProjections.restore(
      rows,
      [anchor],
      SessionLogOffset(9),
      RESTORE_HEADER,
      SessionLogOffset(0),
    )
    expect(anchored.snapshot.values).toEqual({})
    expect(anchored.checkpoint['test/count']).toEqual({ ver: 1, seq: 9, val: 10 })
    // …while a log crash-repaired down to fewer events returns an empty tail:
    // the row overreaches the proven end and a tail read cannot fix this key.
    expect(() => ctx.sessionProjections.restore(
      rows,
      [],
      SessionLogOffset(9),
      RESTORE_HEADER,
      SessionLogOffset(0),
    )).toThrow(/re-read from seq 0/)
    // The full re-read discards the overreaching row and refolds from init.
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore(
      rows,
      events,
      SessionLogOffset(0),
      RESTORE_HEADER,
      SessionLogOffset(0),
    )
    expect(snapshot.asOfSeq).toBe(1)
    expect(snapshot.values).toEqual({})
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 1, val: 2 })
  })

  it('fails loud when a unit view violates its own schema (async unit output is unrepresentable)', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register({
      key: 'test/marks',
      stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
      init: () => null as MarksState,
      apply: state => state,
      wire: {
        viewSchema: z.object({ marks: z.array(z.string()) }),
        // A Promise (what an accidentally-async view would return) is not the
        // declared shape: the boundary parse rejects it before it leaves.
        view: () => Promise.resolve({ marks: [] }) as never,
      },
      stateVersion: 1,
    })
    expect(() => ctx.sessionProjections.snapshot(session)).toThrow()
  })
})
