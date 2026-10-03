import { describe, expect, it } from 'vitest'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceListState } from '@deepseek-ai/dsh-client-test-runtime'
import { sessionLinkState } from '../src/client/session-link.ts'

const id = 'session-original' as SessionId

const ready: WorkspaceListState = workspaceListState()

/** Session list whose Host-list projection is `ids` and whose rows are `byId`. */
function sessions(ids: SessionId[], rows: SessionId[]): SessionListState {
  return {
    ids,
    byId: Object.fromEntries(rows.map(row => [row, {
      id: row, displayTitle: row, running: false, blank: false, updatedAt: 0,
    }] as const)),
    archivedById: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    observedJobs: {},
    currentAddress: undefined,
  }
}

describe('linked Session availability', () => {
  it('accepts a Session the Host list contains', () => {
    expect(sessionLinkState(id, sessions([id], [id]), ready)).toBe('available')
  })

  it('rejects a Session the Host list dropped even while a local fallback row survives', () => {
    // `byId` keeps local fallback rows for live Client generations, so only
    // `ids` expresses Host-list membership.
    const fallback = sessions([], [id])
    expect(fallback.byId[id]).toBeDefined()
    expect(sessionLinkState(id, fallback, ready)).toBe('unavailable')
  })

  it('reports archived and loading ahead of membership', () => {
    expect(sessionLinkState(id, sessions([], []), { ...ready, archivedSessionIds: [id] })).toBe('archived')
    expect(sessionLinkState(id, { ...sessions([], []), phase: 'pending' }, ready)).toBe('loading')
    expect(sessionLinkState(id, sessions([id], [id]), { ...ready, phase: 'pending' })).toBe('loading')
  })
})
