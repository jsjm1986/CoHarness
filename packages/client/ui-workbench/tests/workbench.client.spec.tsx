// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    sessionsStore: sessions, workspacesStore: workspaces,
    useStore: bindSnapshotSelector(store), actions: store.actions,
    useSessions: bindSnapshotSelector(sessions), useWorkspaces: bindSnapshotSelector(workspaces),
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('workbench components', () => {
  it('does not reinsert local sessions excluded by the account catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      personal: { id: 1, name: 'admin' }, activeRuntime: { kind: 'personal' }, projects: [],
      items: [{ sessionId: SID_B, runtime: { kind: 'personal' }, title: 'Beta', cwd: '/work/beta',
        visibility: 'personal', creatorUserId: 1, creatorDisplayName: 'admin', updatedAt: 0, blank: false, canWrite: true }],
    }))))
    render(<WorkbenchToolbar {...props()} viewport={{ mode: 'workbench', paneIds: [], paneRatios: [] }}
      tabbed={false} chooseSession={vi.fn()} focusSession={vi.fn()} createSession={vi.fn()} setMode={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '添加对话' }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Alpha /work/alpha' })).toBeNull() })
    expect(screen.getByRole('button', { name: 'Beta /work/beta' })).toBeTruthy()
  })
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
    fireEvent.click(screen.getByRole('button', { name: '选择工作台' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '退出工作台' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '个人空间' }))
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
    fireEvent.click(screen.getByRole('button', { name: '选择工作台' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /我的工作台/ }))
    expect(changeMode).toHaveBeenCalledWith('workbench')
  })

})


describe('workbench account targets and asynchronous chooser', () => {
  const directory = {
    personal: { id: 1, name: 'My space' }, activeRuntime: { kind: 'project', projectId: 7 },
    projects: [{ projectId: 7, name: 'Team', mode: 'rw' }, { projectId: 8, name: 'Read only', mode: 'ro' }],
    items: [
      { sessionId: 'project', title: 'Project conversation', runtime: { kind: 'project', projectId: 7, projectName: 'Team' }, visibility: 'project', creatorUserId: 1, creatorDisplayName: 'A', updatedAt: 1, blank: false, canWrite: true },
      { sessionId: 'personal', runtime: { kind: 'personal' }, title: 'Private', cwd: '/personal', visibility: 'personal', creatorUserId: 1, creatorDisplayName: 'A', updatedAt: 1, blank: false, canWrite: true },
    ],
  }
  function serve(value: unknown = directory) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })))
  }
  function toolbar(overrides: Partial<ComponentProps<typeof WorkbenchToolbar>> = {}) {
    const p = props()
    const actions = {
      chooseSession: vi.fn(async () => ({ ok: true as const })),
      focusSession: vi.fn(),
      createSession: vi.fn(async () => ({ ok: true as const })),
      setMode: vi.fn(),
    }
    const view = render(<WorkbenchToolbar {...p} viewport={{ mode: 'workbench', paneIds: [], paneRatios: [] }} tabbed={false} {...actions} t={t} {...overrides} />)
    return { ...p, ...actions, view }
  }

  it('hydrates project identities and filters choices by Workspace and query', async () => {
    serve()
    const hydrateCatalog = vi.fn(async () => {})
    toolbar({ hydrateCatalog })
    await waitFor(() => { expect(hydrateCatalog).toHaveBeenCalledWith(expect.objectContaining({ activeRuntime: { kind: 'project', projectId: 7, projectName: 'Team' } }), []) })
    fireEvent.click(screen.getByRole('button', { name: '添加对话' }))
    await screen.findByRole('button', { name: 'Project conversation' })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Team/ }))
    expect(screen.queryByRole('button', { name: 'Private /personal' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } })
    expect(screen.getByText('暂无可添加的会话')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Team' } })
    expect(screen.getByRole('button', { name: 'Project conversation' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Read only/ }))
    expect(screen.getByRole('button', { name: '新建对话' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭选择器' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['limit', 'unknown'] as const)('keeps a refused %s choice visible and reports remote errors', async (reason) => {
    serve()
    const chooseSession = vi.fn().mockResolvedValueOnce({ ok: false, reason }).mockRejectedValueOnce('transport lost').mockRejectedValueOnce(new Error('expired')).mockResolvedValue({ ok: false, reason: 'duplicate' })
    toolbar({ chooseSession })
    fireEvent.click(screen.getByRole('button', { name: '添加对话' }))
    const choice = await screen.findByRole('button', { name: 'Private /personal' })
    fireEvent.click(choice)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(reason === 'limit' ? '最多' : '不可访问') })
    fireEvent.click(choice)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('transport lost') })
    fireEvent.click(choice)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('expired') })
    fireEvent.click(choice)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('creates in a selected project and exposes a non-Error rejection as localized failure', async () => {
    serve()
    const createSession = vi.fn().mockRejectedValueOnce(null).mockResolvedValue({ ok: true })
    toolbar({ createSession })
    fireEvent.click(screen.getByRole('button', { name: '添加对话' }))
    await screen.findByRole('button', { name: 'Workspace' })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Team/ }))
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('无法创建对话，请重试') })
    expect(createSession).toHaveBeenCalledWith({ kind: 'project', projectId: 7 }, false)
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('ignores catalog completion after unmount and marks a failed catalog ready', async () => {
    const pending = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn(() => pending.promise))
    const hydrateCatalog = vi.fn(async () => {})
    const first = toolbar({ hydrateCatalog })
    first.view.unmount()
    await act(async () => { pending.resolve(new Response(JSON.stringify(directory))) })
    expect(hydrateCatalog).not.toHaveBeenCalled()
    const ready = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    toolbar({ markCatalogReady: ready })
    await waitFor(() => { expect(ready).toHaveBeenCalledOnce() })
  })
})

describe('pane header controls', () => {
  function pane(sessionId: SessionId = SID_A, waiting = false) {
    const p = props()
    if (waiting) {
      const state = p.sessionsStore.getSnapshot()
      p.sessionsStore.set({ ...state, byId: { ...state.byId, [SID_A]: { ...state.byId[SID_A]!, pendingInteraction: 'approval' } } })
    }
    const callbacks = { onFocus: vi.fn(), onClose: vi.fn(), onMaximize: vi.fn(), replacePane: vi.fn(), movePane: vi.fn() }
    const view = render(<WorkbenchPaneHeader {...p} {...callbacks} sessionId={sessionId} active={false} maximized
      useSession={(() => undefined) as never} useProjection={() => undefined}
      useInput={(() => undefined) as never} inputActions={{} as never} t={t} />)
    return { ...callbacks, view }
  }
  it('shows waiting state and keeps maximize, close and menu actions separate from pane focus', async () => {
    const p = pane(SID_A, true)
    expect(screen.getByText('等待处理')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '还原布局' }))
    expect(p.onMaximize).toHaveBeenCalledOnce()
    expect(p.onFocus).not.toHaveBeenCalled()
    for (const [name, direction] of [['向前移动', 'previous'], ['向后移动', 'next']] as const) {
      fireEvent.click(screen.getByRole('button', { name: '更多面板操作' }))
      fireEvent.click(await screen.findByRole('menuitem', { name }))
      expect(p.movePane).toHaveBeenCalledWith(direction)
    }
    fireEvent.click(screen.getByRole('button', { name: '更多面板操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '替换当前面板' }))
    expect(p.replacePane).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '更多面板操作' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: '关闭面板' }))
    expect(p.onClose).toHaveBeenCalledOnce()
  })
  it('keeps a missing Session identifiable and marks an idle known Session ready', () => {
    const missing = pane('missing' as SessionId)
    expect(screen.getByText('未命名对话')).toBeTruthy()
    expect(screen.getByText('就绪')).toBeTruthy()
    missing.view.unmount()
    pane()
    expect(screen.getByText('Workspace A')).toBeTruthy()
    expect(screen.getByText('就绪')).toBeTruthy()
  })
})
