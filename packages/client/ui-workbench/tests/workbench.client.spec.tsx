// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type SessionListState, type SessionId, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkbenchEmpty } from '../src/client/components/WorkbenchEmpty.tsx'
import { WorkbenchPaneHeader } from '../src/client/components/WorkbenchPaneHeader.tsx'
import { WorkbenchToolbar } from '../src/client/components/WorkbenchToolbar.tsx'
import { createWorkbenchStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locales.ts'

const SID_A = 'a' as SessionId
const SID_B = 'b' as SessionId
const t = makeTranslate(zh, {}) as never

function props() {
  const sessions = createSnapshotStore<SessionListState>({
    ids: [SID_A, SID_B],
    byId: {
      [SID_A]: { id: SID_A, displayTitle: 'Alpha', cwd: '/work/alpha', running: false, blank: false, updatedAt: 0 },
      [SID_B]: { id: SID_B, displayTitle: 'Beta', cwd: '/work/beta', running: true, blank: false, updatedAt: 0 },
    },
    current: SID_A,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const workspaces = createSnapshotStore<WorkspaceListState>({ items: [{ workspaceId: 'wa' as never, title: 'Workspace A', createdAt: '2026-09-08', updatedAt: '2026-09-08', path: '/work/alpha', sessionIds: [SID_A] }], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined })
  const store = createWorkbenchStore().create()
  return {
    useStore: bindSnapshotSelector(store), actions: store.actions,
    useSessions: bindSnapshotSelector(sessions), useWorkspaces: bindSnapshotSelector(workspaces),
  }
}

afterEach(cleanup)

describe('workbench components', () => {
  it('adds a listed session from the toolbar menu and exposes single mode', () => {
    const addSession = vi.fn(async () => ({ ok: true as const }))
    const setSingle = vi.fn()
    const viewport = { mode: 'workbench' as const, paneIds: [], paneRatios: [] }
    render(<WorkbenchToolbar
      {...props()} viewport={viewport} tabbed={false} chooseSession={addSession}
      focusSession={vi.fn()} createSession={vi.fn()} setMode={setSingle} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '添加对话' }))
    fireEvent.click(screen.getByRole('button', { name: 'Alpha /work/alpha' }))
    expect(addSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SID_A }), false)
    fireEvent.click(screen.getByRole('button', { name: '单会话' }))
    expect(setSingle).toHaveBeenCalledWith('single')
  })

  it('renders the empty action and invokes the supplied add callback', () => {
    const p = props()
    const add = vi.spyOn(p.actions, 'openPicker')
    render(<WorkbenchEmpty {...p} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '添加对话' }))
    expect(add).toHaveBeenCalledOnce()
  })

  it('shows workspace basename, running state, and pane close/focus actions', () => {
    const onFocus = vi.fn()
    const onClose = vi.fn()
    render(<WorkbenchPaneHeader
      {...props()}
      sessionId={SID_B}
      active
      onFocus={onFocus}
      onClose={onClose}
      maximized={false}
      onMaximize={vi.fn()}
      replacePane={vi.fn()}
      movePane={vi.fn()}
      useSession={(() => undefined) as never}
      useProjection={(() => undefined)}
      useInput={(() => undefined) as never}
      inputActions={{} as never}
      t={t}
    />)
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('banner'))
    expect(onFocus).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '关闭面板' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('requires an explicit replacement when full, but allows focusing a duplicate', () => {
    const choose = vi.fn(async () => ({ ok: true as const }))
    const p = props()
    render(<WorkbenchToolbar {...p} viewport={{ mode: 'workbench', paneIds: [SID_A, 'c' as SessionId, 'd' as SessionId, 'e' as SessionId], activePaneId: SID_A, paneRatios: [1, 1, 1, 1] }} tabbed={false} chooseSession={choose} focusSession={vi.fn()} createSession={vi.fn()} setMode={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '添加对话' }))
    expect(screen.getByRole('status').textContent).toContain('最多同时打开 4 个')
    expect(screen.getByRole('button', { name: 'Beta /work/beta' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '替换当前面板' }))
    fireEvent.click(screen.getByRole('button', { name: 'Beta /work/beta' }))
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SID_B }), true)
  })

  it('creates only in the chosen Workspace and keeps a failed create visible', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('Workspace unavailable')).mockResolvedValue({ ok: true })
    render(<WorkbenchToolbar {...props()} viewport={{ mode: 'workbench', paneIds: [], paneRatios: [] }} tabbed={false} chooseSession={vi.fn()} focusSession={vi.fn()} createSession={create} setMode={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '添加对话' }))
    expect(screen.getByRole('button', { name: '新建对话' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), { target: { value: 'personal' } })
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Workspace unavailable') })
    expect(create).toHaveBeenCalledWith({ kind: 'personal' }, false)
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('exposes tab status and arrow-key navigation, and an entry from single mode', () => {
    const focus = vi.fn()
    const changeMode = vi.fn()
    const p = props()
    const view = render(<WorkbenchToolbar {...p} viewport={{ mode: 'workbench', paneIds: [SID_A, SID_B], activePaneId: SID_A, paneRatios: [1, 1] }} tabbed chooseSession={vi.fn()} focusSession={focus} createSession={vi.fn()} setMode={changeMode} t={t} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[1]!.textContent).toContain('运行中')
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })
    expect(focus).toHaveBeenCalledWith(SID_B)
    view.rerender(<WorkbenchToolbar {...p} viewport={{ mode: 'single', paneIds: [], paneRatios: [] }} tabbed={false} chooseSession={vi.fn()} focusSession={focus} createSession={vi.fn()} setMode={changeMode} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '工作台' }))
    expect(changeMode).toHaveBeenCalledWith('workbench')
  })

})
