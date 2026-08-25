// @vitest-environment jsdom
/** AppearanceRow behavior: three cubes, selection follows the persisted
 * preference, clicks drive setTheme. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type SettingsControlState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import type { AppearanceRowComponentProps } from '../src/client/AppearanceRow.tsx'
import { createAppearanceRowStore } from '../src/client/settings-store.ts'
import type { ThemePreference } from '../src/client/index.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'appearance.projectReadOnly': 'Project settings are read-only',
  'appearance.providerReadOnly': 'Provider settings are read-only',
  'appearance.loading': 'Loading settings',
  'appearance.saving': 'Saving',
  'appearance.saveFailed': 'Save failed',
  'appearance.unavailable': 'Unavailable',
}

/** Empty global standard-kit hooks (the row reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function mount(
  preference: ThemePreference = 'system',
  settings: SettingsControlState = {
    status: 'ready', writable: true, writableReason: undefined, write: { status: 'idle' },
  },
) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createAppearanceRowStore().create()
  store.actions.sync(preference, 0, settings)
  const setTheme = vi.fn()
  const props: AppearanceRowComponentProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setTheme,
  }
  render(<AppearanceRow {...props} />)
  return { store, setTheme }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('AppearanceRow', () => {
  it('renders the title and three cubes with the preference cube selected', () => {
    mount('dark')
    expect(screen.getByText('Appearance')).toBeDefined()
    expect(pressed(/Dark/)).toBe('true')
    expect(pressed(/Light/)).toBe('false')
    expect(pressed(/System/)).toBe('false')
  })

  it('click drives setTheme; selection follows the store mirror, not the click echo', () => {
    const b = mount('dark')
    fireEvent.click(screen.getByRole('button', { name: /Light/ }))
    expect(b.setTheme).toHaveBeenCalledWith('light')
    // No store write yet: selection is unchanged.
    expect(pressed(/Dark/)).toBe('true')
    act(() => { b.store.actions.sync('light', 1) })
    expect(pressed(/Light/)).toBe('true')
    expect(pressed(/Dark/)).toBe('false')
  })

  it('disables project-scoped controls and explains the read-only reason', () => {
    mount('dark', { status: 'ready', writable: false, writableReason: 'project', write: { status: 'idle' } })
    const light = screen.getByRole('button', { name: /Light/ })
    expect(light).toHaveProperty('disabled', true)
    expect(screen.getByRole('status').textContent).toContain('Project settings are read-only')
  })
})
