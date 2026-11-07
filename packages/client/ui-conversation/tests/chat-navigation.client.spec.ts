import { describe, expect, it, vi } from 'vitest'
import type {
  ChatConversationViewNode, ConversationTimelineSnapshot, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

function turn(number: number): TurnLocation {
  return {
    turn: number,
    start: { type: 'turn/start', seq: number * 10 as SessionSeq, time: number * 1000, data: { turn: number } },
    end: undefined,
    status: 'open',
    steps: [],
    data: {
      get: () => undefined,
      source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
    },
  }
}

function timeline(turns: readonly TurnLocation[], order: readonly number[] = turns.map(value => value.turn)): ConversationTimelineSnapshot {
  return { turnOrder: order, turns: new Map(turns.map(value => [value.turn, value])) }
}

function input(key: string, location: TurnLocation, text: string): ChatConversationViewNode {
  return {
    key, id: key, kind: 'user', target: 'chat', anchorSeq: location.turn * 10 + 1,
    visibility: 'visible', location: { kind: 'turn', turn: location },
    data: {
      kind: 'user', seq: location.turn * 10 + 1, time: location.turn * 1000 + 1,
      content: [{ type: 'text', text }], source: { kind: 'user' },
    },
  }
}

describe('Chat turn navigation invalidation', () => {
  it('accepts an initial incremental batch and drops hidden-only turns', () => {
    const builder = new ChatSnapshotBuilder()
    const first = turn(1)
    const facts = timeline([first])
    const visible = input('first', first, 'Question')
    const opened = builder.apply({ upserts: [visible], timeline: facts })
    expect(opened.navigation.items()).toMatchObject([{ turn: 1, prompt: 'Question' }])

    const hidden = builder.apply({ upserts: [{ ...visible, visibility: 'hidden' }], timeline: facts })
    expect(hidden.navigation.items()).toEqual([])
    expect(hidden.order).toEqual([])

    const restored = builder.apply({ upserts: [visible], timeline: facts })
    expect(restored.navigation.items()).toMatchObject([{ turn: 1, prompt: 'Question' }])
  })

  it('invalidates both turns when a node moves between them', () => {
    const builder = new ChatSnapshotBuilder()
    const first = turn(1)
    const second = turn(2)
    const facts = timeline([first, second])
    builder.replace({ nodes: [input('moving', first, 'Question')], timeline: facts })

    const moved = builder.apply({ upserts: [input('moving', second, 'Moved question')], timeline: facts })
    expect(moved.navigation.items()).toMatchObject([{ turn: 2, prompt: 'Moved question', anchorKey: 'moving' }])
    expect(moved.locations.getTurn(1)).toEqual([])
    expect(moved.locations.getTurn(2)).toEqual(['moving'])
  })

  it('updates boundary-only changes without reading an unchanged turn', () => {
    const builder = new ChatSnapshotBuilder()
    const first = turn(1)
    const second = turn(2)
    const facts = timeline([first, second])
    const initial = builder.replace({ nodes: [input('a', first, 'First'), input('b', second, 'Second')], timeline: facts })
    const firstMarker = initial.navigation.items()[0]
    const readTurn = vi.spyOn(initial.locations, 'getTurn')
    try {
      const ended: TurnLocation = {
        ...second, status: 'closed',
        end: { type: 'turn/end', seq: 25 as SessionSeq, time: 2500, data: { turn: 2, reason: { kind: 'completed' } } },
      }
      const current = builder.apply({ upserts: [], timeline: timeline([first, ended], facts.turnOrder) })
      expect(current.navigation.items()[0]).toBe(firstMarker)
      expect(current.navigation.items()[1]?.endSeq).toBe(25)
      expect(readTurn.mock.calls).toEqual([[2]])
    } finally {
      readTurn.mockRestore()
    }
  })

  it('preserves unchanged markers on reorder and clears them on full replacement', () => {
    const builder = new ChatSnapshotBuilder()
    const first = turn(1)
    const second = turn(2)
    const nodes = [input('a', first, 'First'), input('b', second, 'Second')]
    const initial = builder.replace({ nodes, timeline: timeline([first, second]) })
    const firstMarker = initial.navigation.items()[0]
    const secondMarker = initial.navigation.items()[1]

    const reordered = builder.apply({ upserts: [], timeline: timeline([second, first]) })
    expect(reordered.navigation.items()).toEqual([secondMarker, firstMarker])
    expect(reordered.navigation.items()[0]).toBe(secondMarker)
    expect(reordered.navigation.items()[1]).toBe(firstMarker)
    const cleared = builder.replace({ nodes: [], timeline: timeline([]) })
    expect(cleared.navigation.items()).toEqual([])
    const replaced = builder.replace({ nodes: [input('fresh', first, 'Fresh')], timeline: timeline([first]) })
    expect(replaced.navigation.items()).toMatchObject([{ turn: 1, prompt: 'Fresh', anchorKey: 'fresh' }])
    expect(replaced.navigation.items()[0]).not.toBe(firstMarker)
  })
})
