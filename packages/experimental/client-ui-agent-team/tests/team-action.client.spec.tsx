// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TeamProjection, TeamTaskId, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  TeamAction, type TeamActionInjected, type TeamActionProps,
} from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'lead' as SessionId
const WORKER = 'worker-id' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}

interface BenchState {
  team?: TeamProjection
  childSession?: boolean
  catalog?: { entries: unknown[] }
}

const enabledTeam: BenchState['team'] = { enabled: true, tasks: [task] }
const catalog: BenchState['catalog'] = {
  entries: [{ kind: 'child', id: WORKER, label: 'worker', activity: 'inactive' }],
}

function props(
  actions: TeamActionInjected,
  state: BenchState = {},
  sessionId: SessionId = SESSION,
): TeamActionProps {
  const bench: BenchState = { team: enabledTeam, catalog, ...state }
  return {
    sessionId,
    useSession: (select: (snapshot: { subagent: unknown }) => unknown) =>
      select({ subagent: bench.childSession === true ? { address: {} } : null }),
    useSessions: (select: (snapshot: unknown) => unknown) =>
      select({
        byId: { [sessionId]: { origin: bench.childSession === true ? 'subagent' : 'user' } },
        subagentsByParent: { [SESSION]: bench.catalog },
      }),
    useProjection: (key: string) => key === 'agentTeam' ? bench.team : undefined,
    ...actions,
    t: makeTranslate(zh, commonZh),
  } as unknown as TeamActionProps
}

function actions(overrides: Partial<TeamActionInjected> = {}): TeamActionInjected {
  return {
    selectTeamMode: () => Promise.resolve(null),
    refreshMembers: () => Promise.resolve(),
    openTeammate: () => Promise.resolve(),
    ...overrides,
  }
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  return screen.findByRole('dialog')
}

describe('TeamAction', () => {
  it('renders the catalog roster and shared task board inside the panel', async () => {
    render(<TeamAction {...props(actions())} />)
    await openPanel()
    expect(await screen.findByText('Implement runtime')).toBeTruthy()
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    expect(screen.getByRole('button', { name: /worker/u })).toBeTruthy()
    const current = screen.getByRole('button', { name: /Lead/u }) as HTMLButtonElement
    expect(current.disabled).toBe(true)
    expect(screen.getByText(zh.current)).toBeTruthy()
  })

  it('hides the trigger on addressed child Sessions', () => {
    render(<TeamAction {...props(actions(), { childSession: true })} />)
    expect(screen.queryByRole('button', { name: /Agent Team/u })).toBeNull()
  })

  it('shows the disabled notice and no board while Team mode is off', async () => {
    render(<TeamAction {...props(actions(), { team: { enabled: false, tasks: [] } })} />)
    await openPanel()
    expect(await screen.findByText(zh['mode.disabled'])).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

  it('selects Team mode through the switch and reports failures', async () => {
    const selectTeamMode = vi.fn(() => Promise.resolve('offline'))
    render(<TeamAction {...props(actions({ selectTeamMode }), { team: { enabled: false, tasks: [] } })} />)
    await openPanel()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => { expect(selectTeamMode).toHaveBeenCalledWith(SESSION, true) })
    expect(await screen.findByText(/offline/u)).toBeTruthy()
  })

  it('requires a second gesture before disabling Team mode', async () => {
    const selectTeamMode = vi.fn(() => Promise.resolve(null))
    render(<TeamAction {...props(actions({ selectTeamMode }))} />)
    await openPanel()
    fireEvent.click(screen.getByRole('switch'))
    expect(selectTeamMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['disable.confirm'] }))
    await waitFor(() => { expect(selectTeamMode).toHaveBeenCalledWith(SESSION, false) })
  })

  it('navigates a teammate row through openTeammate', async () => {
    const openTeammate = vi.fn(() => Promise.resolve())
    render(<TeamAction {...props(actions({ openTeammate }))} />)
    await openPanel()
    fireEvent.click(await screen.findByRole('button', { name: /worker/u }))
    await waitFor(() => { expect(openTeammate).toHaveBeenCalledWith(SESSION, WORKER) })
  })

  it('renders nothing without a Team projection', () => {
    render(<TeamAction {...props(actions(), { team: undefined })} />)
    expect(screen.queryByRole('button', { name: /Agent Team/u })).toBeNull()
  })
})
