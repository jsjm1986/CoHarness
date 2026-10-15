// @vitest-environment jsdom
// ConversationRoot's workbench grid: dynamic 1-4 panes, collapsed identity
// strips, separator handles, pane drag ordering, and the layout preset owner
// share handed to the toolbar seat.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { createConversationViewportStore } from '../src/client/viewport.ts'
import { ConversationRoot, type ConversationRootProps } from '../src/client/skeleton/ConversationRoot.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

const A = 'a' as SessionId
const B = 'b' as SessionId
const C = 'c' as SessionId
const t = makeTranslate(zh, commonZh) as ConversationRootProps['t']

afterEach(() => { cleanup() })

/** Render the root in workbench mode over a writable viewport store. */
function grid(paneIds: SessionId[] = [A, B], collapsed: SessionId[] = []) {
  const store = createConversationViewportStore().create()
  store.actions.replace({
    mode: 'workbench', paneIds, paneRatios: paneIds.map(() => 1 / paneIds.length),
    collapsedIds: collapsed, activePaneId: paneIds[0]!,
  })
  const calls = {
    focus: vi.fn(), remove: vi.fn(), ratios: vi.fn(), reorder: vi.fn(),
    collapse: vi.fn(), solo: vi.fn(), maximize: vi.fn(), enabled: vi.fn(),
  }
  // Header owner shares arrive in pane order; the session scope binds the id
  // outside the owner share, so the harness aligns capture order to paneIds.
  const headerOwners: Record<string, unknown>[] = []
  let toolbarOwner: Record<string, unknown> | undefined
  const renderSlot = ((key: string, owner: object) => {
    if (key === 'conversation.workbench.toolbar') { toolbarOwner = owner as Record<string, unknown>; return <div data-testid="wb-toolbar" /> }
    if (key === 'conversation.workbench.empty') return <div data-testid="wb-empty" />
    if (key === 'conversation.workbench.pane.header') {
      headerOwners.push(owner as Record<string, unknown>)
      // The header's identity region carries the drag handle attribute.
      return <div data-testid="pane-header" data-pane-drag="" draggable />
    }
    if (key === 'conversation.pane') return <div data-testid="pane-body" />
    return null
  }) as ConversationRootProps['renderSlot']
  const view = render(<ConversationRoot
    SessionProvider={({ sessionId, children }) => <>{children(sessionId as SessionId)}</>}
    useStore={bindSnapshotSelector(store)}
    actions={store.actions as ConversationRootProps['actions']}
    renderSlot={renderSlot}
    useViewportAvailable={bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} })}
    useSessions={bindSnapshotSelector(createSnapshotStore<SessionListState>(
      { ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, observedJobs: {}, currentAddress: undefined }))}
    useWorkspaces={bindSnapshotSelector(createSnapshotStore<WorkspaceListState>(
      { items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined }))}
    usePanelInfo={bindSnapshotSelector(createSnapshotStore({ activePanelId: null }))}
    onViewportFocus={calls.focus}
    onViewportRemove={calls.remove}
    onViewportRatios={calls.ratios}
    onViewportReorder={calls.reorder}
    onViewportCollapse={calls.collapse}
    onViewportSolo={calls.solo}
    onViewportMaximize={calls.maximize}
    onViewportEnabled={calls.enabled}
    t={t}
  />)
  const headers = (): Record<string, unknown>[] => headerOwners.slice(-store.getSnapshot().paneIds.length)
  return { view, store, calls, headers, toolbarOwner: () => toolbarOwner }
}

describe('workbench grid', () => {
  it('renders exactly the live panes for any 1-4 count, never ghost cells', () => {
    for (const count of [1, 2, 3, 4]) {
      cleanup()
      const ids = [A, B, C, 'd' as SessionId].slice(0, count)
      const { view } = grid(ids)
      expect(view.container.querySelectorAll('[data-session-pane]').length).toBe(count)
      expect(view.container.querySelectorAll('[data-pane-empty]').length).toBe(0)
    }
  })

  it('parks a collapsed pane as an identity strip and hides its body', () => {
    const { view, headers } = grid([A, B, C], [B])
    const strip = view.container.querySelector('[data-session-pane="b"]')
    expect(strip?.hasAttribute('data-collapsed')).toBe(true)
    const owners = headers()
    expect(owners[1]!.collapsed).toBe(true)
    // Collapse is offered only while another pane stays expanded.
    expect(owners[1]!.collapsible).toBe(true)
    expect(typeof owners[2]!.onToggleCollapse).toBe('function')
  })

  it('refuses collapse affordance when only one pane stays expanded', () => {
    const { headers } = grid([A, B], [B])
    expect(headers()[0]!.collapsible).toBe(false)
    expect(headers()[0]!.solo).toBe(true)
  })

  it('resizes adjacent panes from the separator and equalizes on double click', () => {
    const { view, calls } = grid([A, B])
    const separator = view.container.querySelector('[role="separator"]')
    expect(separator).toBeTruthy()
    fireEvent.doubleClick(separator!)
    expect(calls.ratios).toHaveBeenCalledWith([1, 1])
  })

  it('reorders a pane by dropping onto a sibling edge', () => {
    const { view, calls } = grid([A, B, C])
    const source = view.container.querySelector('[data-session-pane="a"] [data-pane-drag]')
    const target = view.container.querySelector('[data-session-pane="c"]')
    expect(source).toBeTruthy()
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(source!, { dataTransfer })
    // jsdom rects are zero-sized and drop events drop clientX, so define it.
    const drop = createEvent.drop(target!, { dataTransfer })
    Object.defineProperty(drop, 'clientX', { value: 10 })
    fireEvent(target!, drop)
    expect(calls.reorder).toHaveBeenCalledWith(A, 2)
  })

  it('hands the toolbar the layout preset callback which applies presets and tabbed mode', () => {
    const { view, calls, toolbarOwner } = grid([A, B, C])
    const owner = toolbarOwner()
    expect(owner?.onSelectLayout).toBeTypeOf('function')
    const apply = owner?.onSelectLayout as (preset: string) => void
    apply('lead')
    expect(calls.ratios).toHaveBeenCalledWith([2, 1, 1])
    act(() => { apply('tabbed') })
    expect(view.container.querySelector('[data-workbench]')?.hasAttribute('data-tabbed')).toBe(true)
    expect(view.container.querySelectorAll('[data-session-pane]').length).toBe(1)
  })

  it('focuses a pane on pointer down and routes header actions to viewport callbacks', () => {
    const { view, calls, headers } = grid([A, B])
    const sectionB = view.container.querySelector('[data-session-pane="b"]')
    fireEvent.pointerDown(sectionB!)
    expect(calls.focus).toHaveBeenCalledWith(B)
    const a = headers()[0]!
    ;(a.onSolo as () => void)()
    expect(calls.solo).toHaveBeenCalledWith(A)
    ;(a.onToggleCollapse as () => void)()
    expect(calls.collapse).toHaveBeenCalledWith(A, true)
    ;(a.onClose as () => void)()
    expect(calls.remove).toHaveBeenCalledWith(A)
  })
})
