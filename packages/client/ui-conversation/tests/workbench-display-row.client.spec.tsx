// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationDisplaySettings } from '../src/client/display-settings.ts'
import { WorkbenchDisplayRow } from '../src/client/settings/WorkbenchDisplayRow.tsx'
import type { WorkbenchDisplayRowProps } from '../src/client/settings/WorkbenchDisplayRow.tsx'
import type { ConversationSettings } from '../src/submission-settings.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear() })

function mount() {
  const scope = stubSettingsScope<ConversationSettings>()
  const settings = new ConversationDisplaySettings(scope.scope)
  const props: WorkbenchDisplayRowProps = {
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, observedJobs: {}, currentAddress: undefined,
    })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })),
    usePanelInfo: bindSnapshotSelector(createSnapshotStore({ activePanelId: null })),
    useDisplaySettings: bindSnapshotSelector(settings),
    setWidth: vi.fn((value: number) => { settings.setWidth(value) }),
    setFullWidth: vi.fn((value: boolean) => { settings.setFullWidth(value) }),
    setFontSize: vi.fn((value: number) => { settings.setFontSize(value) }),
    t: makeTranslate(en),
  }
  render(<WorkbenchDisplayRow {...props} />)
  return { scope, settings, props }
}

function publishReady(scope: ReturnType<typeof stubSettingsScope<ConversationSettings>>): void {
  act(() => {
    scope.publish({
      status: 'ready', writable: true,
      value: {
        chatContentWidth: 720, chatFontSize: 15, chatFullWidth: false, busyEnter: 'queue',
        performanceUsage: 'detailed', linkOpening: 'sidebar',
      },
    })
  })
}

describe('WorkbenchDisplayRow', () => {
  it('stacks width, font size, and fill controls bound to the shared settings face', () => {
    const b = mount()
    publishReady(b.scope)
    fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }))
    expect(b.props.setFontSize).toHaveBeenCalledWith(16)
    expect(b.scope.set).toHaveBeenCalledWith('chatFontSize', 16)
    // The write published back through the snapshot, so decrease steps from 16.
    fireEvent.click(screen.getByRole('button', { name: 'Decrease font size' }))
    expect(b.props.setFontSize).toHaveBeenCalledWith(15)
    // A stored custom width lights no preset; picking one writes the preset value.
    expect(screen.getByRole('group', { name: 'Content width' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Relaxed' }))
    expect(b.props.setWidth).toHaveBeenCalledWith(960)
    expect(b.props.setFullWidth).toHaveBeenCalledWith(false)
    expect(b.scope.set).toHaveBeenCalledWith('chatContentWidth', 960)
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    expect(b.props.setFullWidth).toHaveBeenCalledWith(true)
    expect(b.scope.set).toHaveBeenCalledWith('chatFullWidth', true)
    // Fill mode marks the Fill segment and clears preset selection.
    expect(screen.getByRole('button', { name: 'Fill' })).toHaveProperty('ariaPressed', 'true')
    expect(screen.getByRole('button', { name: 'Relaxed' })).toHaveProperty('ariaPressed', 'false')
  })

  it('keeps controls disabled and surfaces the loading notice before settings are ready', () => {
    mount()
    expect(screen.getByText(/Loading display settings/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Increase font size' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Fill' })).toHaveProperty('disabled', true)
  })

  it('reports read-only scopes and write failures through the notice line', () => {
    const b = mount()
    publishReady(b.scope)
    act(() => {
      b.scope.publish({ writable: false, writableReason: 'project' })
    })
    expect(screen.getByText(/Project settings are managed/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Increase font size' })).toHaveProperty('disabled', true)
    act(() => {
      b.scope.publish({ writable: true, writableReason: undefined, write: { status: 'error', code: 'x', message: 'x' } })
    })
    expect(screen.getByRole('alert').textContent).toContain('could not be saved')
  })
})
