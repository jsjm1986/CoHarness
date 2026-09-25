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
      ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({
      items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })),
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
      value: { chatContentWidth: 720, chatFontSize: 15, chatFullWidth: false, busyEnter: 'queue' },
    })
  })
}

describe('WorkbenchDisplayRow', () => {
  it('stacks width, font size, and fill controls bound to the shared settings face', () => {
    const b = mount()
    publishReady(b.scope)
    fireEvent.change(screen.getByRole('slider', { name: 'Text size' }), { target: { value: '16' } })
    expect(b.props.setFontSize).toHaveBeenCalledWith(16)
    expect(b.scope.set).toHaveBeenCalledWith('chatFontSize', 16)
    fireEvent.change(screen.getByRole('slider', { name: 'Content width' }), { target: { value: '700' } })
    expect(b.props.setWidth).toHaveBeenCalledWith(700)
    expect(b.scope.set).toHaveBeenCalledWith('chatContentWidth', 700)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fill' }))
    expect(b.props.setFullWidth).toHaveBeenCalledWith(true)
    expect(b.scope.set).toHaveBeenCalledWith('chatFullWidth', true)
    // Fill mode disables the pixel slider and reports the fill state.
    expect(screen.getByRole('slider', { name: 'Content width' })).toHaveProperty('disabled', true)
  })

  it('keeps controls disabled and surfaces the loading notice before settings are ready', () => {
    mount()
    expect(screen.getByText(/Loading display settings/)).toBeDefined()
    expect(screen.getByRole('slider', { name: 'Text size' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox', { name: 'Fill' })).toHaveProperty('disabled', true)
  })

  it('reports read-only scopes and write failures through the notice line', () => {
    const b = mount()
    publishReady(b.scope)
    act(() => {
      b.scope.publish({ writable: false, writableReason: 'project' })
    })
    expect(screen.getByText(/Project settings are managed/)).toBeDefined()
    expect(screen.getByRole('slider', { name: 'Text size' })).toHaveProperty('disabled', true)
    act(() => {
      b.scope.publish({ writable: true, writableReason: undefined, write: { status: 'error', code: 'x', message: 'x' } })
    })
    expect(screen.getByRole('alert').textContent).toContain('could not be saved')
  })
})
