/** Composer ownership keeps only this document's authorized blank rows discoverable. */
import { expect, it, vi } from 'vitest'
import { createSnapshotStore, type SessionId, type SessionListState, type SessionRetainInfo } from '@deepseek-ai/dsh-client-runtime/client'
import { observeInputDraftSessions } from '../src/client/draft-sessions.ts'

const id = (value: string) => value as SessionId
function fixture() {
  const a = id('blank-a'), b = id('blank-b'), ordinary = id('ordinary')
  const list = createSnapshotStore<SessionListState>({
    ids: [a, b, ordinary], byId: Object.fromEntries([a, b, ordinary].map(key => [key, {
      id: key, displayTitle: '', blank: key !== ordinary, running: false, updatedAt: 0,
    }])), archivedById: {}, phase: 'ready', current: ordinary, currentAddress: undefined,
    state: 'idle', error: null,
    subagentsByParent: {}, jobsBySession: {}, observedJobs: {},
  })
  const counts = new Map([a, b].map(key => [key, createSnapshotStore<SessionRetainInfo>({ referenceCount: 0, retainedBy: {} })]))
  const retainInfo = vi.fn((key: SessionId) => counts.get(key)!)
  const publish = vi.fn()
  const dispose = observeInputDraftSessions({ list, retainInfo }, publish)
  return { a, b, ordinary, list, counts, retainInfo, publish, dispose }
}

it('observes existing blank references without acquiring an ordinary or unknown Session', () => {
  const f = fixture()
  try {
    expect(f.retainInfo.mock.calls).toEqual([[f.a], [f.b]])
    f.counts.get(f.a)!.set({ referenceCount: 1, retainedBy: { composer: 1 } })
    expect(f.publish).toHaveBeenLastCalledWith([f.a])
    const notifications = f.publish.mock.calls.length
    f.counts.get(f.a)!.set({ referenceCount: 2, retainedBy: { composer: 2 } })
    expect(f.publish).toHaveBeenCalledTimes(notifications)
    f.counts.get(f.b)!.set({ referenceCount: 1, retainedBy: { conversation: 1 } })
    expect(f.publish).toHaveBeenCalledTimes(notifications)
    f.counts.get(f.a)!.set({ referenceCount: 0, retainedBy: {} })
    expect(f.publish).toHaveBeenLastCalledWith([])
  } finally { f.dispose() }
})

it('withdraws rows with their directory and stops late reference notifications on disposal', () => {
  const f = fixture()
  f.counts.get(f.b)!.set({ referenceCount: 1, retainedBy: { composer: 1 } })
  expect(f.publish).toHaveBeenLastCalledWith([f.b])
  f.list.set({ ...f.list.getSnapshot(), ids: [f.a, f.ordinary], byId: {
    [f.a]: f.list.getSnapshot().byId[f.a]!, [f.ordinary]: f.list.getSnapshot().byId[f.ordinary]!,
  } })
  expect(f.publish).toHaveBeenLastCalledWith([])
  const notifications = f.publish.mock.calls.length
  f.counts.get(f.b)!.set({ referenceCount: 2, retainedBy: { composer: 2 } })
  expect(f.publish).toHaveBeenCalledTimes(notifications)
  f.dispose()
  f.counts.get(f.a)!.set({ referenceCount: 1, retainedBy: { composer: 1 } })
  f.list.set({ ...f.list.getSnapshot(), current: f.a })
  expect(f.publish).toHaveBeenCalledTimes(notifications)
})

it('keeps the same Session identity independent in two document owners', () => {
  const first = fixture(), second = fixture()
  try {
    first.counts.get(first.a)!.set({ referenceCount: 1, retainedBy: { composer: 1 } })
    expect(first.publish).toHaveBeenLastCalledWith([first.a])
    expect(second.publish).not.toHaveBeenCalled()
  } finally { first.dispose(); second.dispose() }
})
