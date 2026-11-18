import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  emptyTeamState,
  teamProjectionDefinition,
  teamProjectionView,
} from '../src/projection.ts'
import { TeamId, TeamTaskId } from '../src/types.ts'
import type { TeamTaskSnapshot } from '../src/types.ts'

const ROOT = SessionId('team-root')
const TEAM = TeamId(ROOT)

function event(type: 'team/task' | 'team/mode', data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: seq } as SessionEvent
}

function task(overrides: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return {
    id: TeamTaskId('task-1'),
    revision: 1,
    subject: 'subject',
    description: 'description',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ...overrides,
  }
}

function apply(state: ReturnType<typeof emptyTeamState>, next: SessionEvent) {
  return teamProjectionDefinition.apply(state, next)
}

describe('agentTeam projection', () => {
  it('initializes empty state from the Session header', () => {
    const state = emptyTeamState(ROOT)
    expect(state).toEqual({ inheritedEventCount: 0, id: TEAM, tasks: [], nextTaskNumber: 1 })
    expect(teamProjectionView(state)).toEqual({ enabled: false, tasks: [] })
  })

  it('selects Team mode through team/mode and ignores inherited prefix rows', () => {
    let state = emptyTeamState(ROOT, 5)
    state = apply(state, event('team/mode', { enabled: false }, 2))
    expect(state.enabled).toBeUndefined()
    state = apply(state, event('team/mode', { enabled: true }, 6))
    expect(state.enabled).toBe(true)
    state = apply(state, event('team/mode', { enabled: false }, 7))
    expect(teamProjectionView(state).enabled).toBe(false)
  })

  it('folds version 1 task records for durable compatibility reads', () => {
    const state = apply(emptyTeamState(ROOT), event('team/task', {
      version: 1, teamId: TEAM, task: task(),
    }, 1))
    expect(state.failure).toBeUndefined()
    expect(state.tasks[0]?.id).toBe(TeamTaskId('task-1'))
    // Historical task records imply Team mode for immutable v1 logs.
    expect(teamProjectionView(state).enabled).toBe(true)
  })

  it('folds version 2 task records and advances nextTaskNumber', () => {
    let state = apply(emptyTeamState(ROOT), event('team/task', {
      version: 2, teamId: TEAM, task: task({ id: TeamTaskId('task-4') }),
    }, 1))
    expect(state.nextTaskNumber).toBe(5)
    state = apply(state, event('team/task', {
      version: 2, teamId: TEAM,
      task: task({ id: TeamTaskId('task-4'), revision: 2, status: 'completed' }),
    }, 2))
    expect(state.tasks[0]?.status).toBe('completed')
  })

  it('retains unsupported versions as projection failure', () => {
    const state = apply(emptyTeamState(ROOT), event('team/task', {
      version: 9, teamId: TEAM, task: task(),
    }, 1))
    expect(state.failure).toContain('version 9')
    expect(teamProjectionView(state).failure).toBe(state.failure)
  })

  it('rejects non-contiguous revisions and foreign Team ids stay inert', () => {
    let state = apply(emptyTeamState(ROOT), event('team/task', {
      version: 2, teamId: TeamId(SessionId('other')), task: task(),
    }, 1))
    expect(state.tasks).toHaveLength(0)
    state = apply(state, event('team/task', {
      version: 2, teamId: TEAM, task: task({ revision: 4 }),
    }, 2))
    expect(state.failure).toContain('revision 1')
  })

  it('hides deleted tombstones from the wire view', () => {
    let state = apply(emptyTeamState(ROOT), event('team/task', {
      version: 2, teamId: TEAM, task: task(),
    }, 1))
    state = apply(state, event('team/task', {
      version: 2, teamId: TEAM, task: task({ revision: 2, status: 'deleted' }),
    }, 2))
    expect(state.tasks[0]?.status).toBe('deleted')
    expect(teamProjectionView(state).tasks).toHaveLength(0)
  })
})
