// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TeamTaskId, TeamTaskView as TeamTask, TeamView,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  TeamAction, type TeamActionInjected, type TeamActionProps, type TeamActionResult,
} from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'lead' as SessionId
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
const view: TeamView = {
  members: [
    { id: SESSION, name: 'lead', role: 'lead', status: 'idle', model: 'model-a', diagnostics: [] },
    {
      id: 'worker-id' as SessionId,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      model: 'model-a',
      diagnostics: [],
    },
  ],
  tasks: [task],
}

function remoteFailure(message: string): TeamActionResult<never> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

function props(actions: TeamActionInjected, sessionId: SessionId = SESSION): TeamActionProps {
  return {
    sessionId,
    ...actions,
    t: makeTranslate(zh, commonZh),
  } as unknown as TeamActionProps
}

function actions(overrides: Partial<TeamActionInjected> = {}): TeamActionInjected {
  return {
    load: () => Promise.resolve({ ok: true, value: view }),
    openTeammate: () => Promise.resolve(),
    ...overrides,
  }
}

describe('TeamAction', () => {
  it('ignores a stale Team load after the conversation switches sessions', async () => {
    const nextSession = 'next-lead' as SessionId
    const firstLoad = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const nextView: TeamView = {
      ...view,
      members: [{ id: nextSession, name: 'lead', role: 'lead', status: 'idle', diagnostics: [] }],
      tasks: [{ ...task, id: 'task-next' as TeamTaskId, subject: 'Next session task' }],
    }
    const load = vi.fn((sessionId: SessionId) => sessionId === SESSION
      ? firstLoad.promise
      : Promise.resolve({ ok: true as const, value: nextView }))
    const injected = actions({ load })
    const rendered = render(<TeamAction {...props(injected)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await waitFor(() => { expect(load).toHaveBeenCalledWith(SESSION) })

    rendered.rerender(<TeamAction {...props(injected, nextSession)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('Next session task')).toBeTruthy()
    firstLoad.resolve({ ok: true, value: view })
    await Promise.resolve()

    await waitFor(() => {
      expect(screen.getByText('Next session task')).toBeTruthy()
      expect(screen.queryByText('Implement runtime')).toBeNull()
    })
  })

  it('loads roster/task diagnostics on open and navigates a healthy teammate', async () => {
    const openTeammate = vi.fn(() => Promise.resolve())
    render(<TeamAction {...props(actions({ openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    const worker = await screen.findByRole('button', { name: /worker/u })
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    fireEvent.click(worker)
    await waitFor(() => { expect(openTeammate).toHaveBeenCalledWith(SESSION, view.members[1]) })
  })

  it('keeps only the newest overlapping refresh for one session', async () => {
    const older = Promise.withResolvers<TeamActionResult<TeamView>>()
    const newer = Promise.withResolvers<TeamActionResult<TeamView>>()
    const newestView = {
      ...view,
      tasks: [{ ...task, id: 'newest-task' as TeamTaskId, subject: 'Newest task' }],
    }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    render(<TeamAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    const refresh = screen.getByRole('button', { name: zh.refresh })
    fireEvent.click(refresh)
    fireEvent.click(refresh)
    newer.resolve({ ok: true, value: newestView })
    expect(await screen.findByText('Newest task')).toBeTruthy()
    older.resolve({ ok: true, value: view })
    await Promise.resolve()

    expect(screen.getByText('Newest task')).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

  it('renders the board read-only: owner as text and no mutation controls', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const mixedView: TeamView = {
      ...view,
      tasks: [
        { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
        { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false },
        { ...task, id: 'completed-task' as TeamTaskId, status: 'completed' },
      ],
    }
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: mixedView }),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText(zh.ready)

    expect(screen.getByText(zh.blocked)).toBeTruthy()
    expect(screen.getAllByText(new RegExp(zh.unowned, 'u')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: /新建任务/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /编辑/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /完成/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /删除/u })).toBeNull()
    expect(screen.queryByPlaceholderText('任务标题')).toBeNull()
  })

  it('renders roster/task state variants and contains navigation, refresh, and close actions', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const richView: TeamView = {
      ...view,
      members: [
        view.members[0]!,
        { ...view.members[1]!, status: 'running' },
        {
          id: 'failed-id' as SessionId,
          name: 'failed-worker',
          role: 'teammate',
          status: 'failed',
          diagnostics: ['provider failed'],
        },
        {
          id: 'provisioning-id' as SessionId,
          name: 'provisioning-worker',
          role: 'teammate',
          status: 'provisioning',
          diagnostics: [],
        },
      ],
      tasks: [
        { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
        { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false },
        { ...task, id: 'completed-task' as TeamTaskId, status: 'completed' },
      ],
    }
    const load = vi.fn(() => Promise.resolve({ ok: true as const, value: richView }))
    const openTeammate = vi.fn(() => Promise.reject(new Error('navigation failed')))
    render(<TeamAction {...props(actions({ load, openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('provider failed')).toBeTruthy()
    expect(screen.getByText(zh.ready)).toBeTruthy()
    expect(screen.getByText(zh.blocked)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /failed-worker/u }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /provisioning-worker/u }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^worker运行中/u }))
    expect(await screen.findByText('Error: navigation failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows load failures', async () => {
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve(remoteFailure('load failed')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('load failed (gateway/internal)')).toBeTruthy()
  })
})
