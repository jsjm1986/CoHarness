import { describe, expect, it } from 'vitest'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceListState } from '@deepseek-ai/dsh-client-test-runtime'
import { sessionLabel, sessionLinkState } from '../src/client/session-link.ts'

const id = 'session-original' as SessionId

const ready: WorkspaceListState = workspaceListState()

/** Session list whose Host-list projection is `ids`, live rows are `byId`, and archived rows `archivedById`. */
function sessions(ids: SessionId[], rows: SessionId[], archived: SessionId[] = []): SessionListState {
  const summary = (row: SessionId) => ({
    id: row, displayTitle: row, running: false, blank: false, updatedAt: 0,
  })
  return {
    ids,
    byId: Object.fromEntries(rows.map(row => [row, summary(row)] as const)),
    archivedById: Object.fromEntries(archived.map(row => [row, summary(row)] as const)),
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
    // The archived partition merges every pooled runtime's set, including
    // runtimes the base Workspace mirror does not cover.
    expect(sessionLinkState(id, sessions([], [], [id]), ready)).toBe('archived')
    expect(sessionLinkState(id, { ...sessions([], []), phase: 'pending' }, ready)).toBe('loading')
    expect(sessionLinkState(id, sessions([id], [id]), { ...ready, phase: 'pending' })).toBe('loading')
  })

  it('labels an archived linked Session from the archived partition', () => {
    const titled = sessions([], [], [id])
    titled.archivedById[id] = { ...titled.archivedById[id]!, title: 'Retained task' }
    expect(sessionLabel(id, titled)).toEqual({ text: 'Retained task', titled: true })
    expect(sessionLabel(id, sessions([], []))).toEqual({ text: id, titled: false })
  })
})
