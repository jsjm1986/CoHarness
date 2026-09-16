/** Fold coverage for the durable model-selection projection unit. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { modelSelectionProjectionDefinition } from '../src/model-selection-projection.ts'
import type { ModelSelectionProjectionState } from '../src/api/sessions.ts'

const apply = modelSelectionProjectionDefinition.apply
const empty: ModelSelectionProjectionState = { lastUsed: null, pending: null }

function selection(provider: string, model: string, reasoningEffort?: string): SessionEvent {
  return {
    type: 'model/selection', seq: 1, time: 1,
    data: { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } },
  } as SessionEvent
}

function header(provider: string, model: string, reasoningEffort?: string): SessionEvent {
  return {
    type: 'request/header', seq: 2, time: 2,
    data: { header: { config: { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } } } },
  } as SessionEvent
}

describe('modelSelectionProjectionDefinition', () => {
  it('tracks a pending selection until a matching request header consumes it', () => {
    let state = apply(empty, selection('deepseek', 'v4-flash'))
    expect(state.pending).toEqual({ provider: 'deepseek', model: 'v4-flash' })

    // An identical re-selection is a no-op.
    expect(apply(state, selection('deepseek', 'v4-flash'))).toBe(state)

    // A request under the pending selection clears it into lastUsed.
    state = apply(state, header('deepseek', 'v4-flash'))
    expect(state).toEqual({
      lastUsed: { provider: 'deepseek', model: 'v4-flash' }, pending: null,
    })
  })

  it('keeps a divergent pending selection beside the last used one', () => {
    let state = apply(empty, selection('deepseek', 'v4-flash'))
    state = apply(state, header('other', 'm1', 'high'))
    expect(state.lastUsed).toEqual({ provider: 'other', model: 'm1', reasoningEffort: 'high' })
    expect(state.pending).toEqual({ provider: 'deepseek', model: 'v4-flash' })
  })

  it('returns the same state when a header repeats the last used selection', () => {
    const state = apply(empty, header('deepseek', 'v4-flash'))
    expect(state.lastUsed).toEqual({ provider: 'deepseek', model: 'v4-flash' })
    expect(apply(state, header('deepseek', 'v4-flash'))).toBe(state)
  })

  it('ignores unrelated event types', () => {
    const event = { type: 'turn/start', seq: 3, time: 3, data: { turn: 1 } } as SessionEvent
    expect(apply(empty, event)).toBe(empty)
  })
})
