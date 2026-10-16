// @vitest-environment jsdom
/** FontSettingsGroup behavior: the text font-size row shows collapsed, its
 * disclosure button toggles the font and size rows, and each row routes its
 * write to its own role. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { FontSettingsGroup } from '../src/client/FontSettingsGroup.tsx'
import type { FontSettingsGroupProps } from '../src/client/FontSettingsGroup.tsx'
import { createFontRowStore } from '../src/client/settings-store.ts'


afterEach(cleanup)

const COPY: Record<string, string> = {
  'fontSize.more': 'More font settings',
  'fontSize.text.title': 'Font size',
  'fontFamily.code.title': 'Code font',
  'fontFamily.terminal.title': 'Terminal font',
  'fontSize.code.increase': 'Increase code font size',
  'fontSize.terminal.decrease': 'Decrease terminal font size',
}

/** Empty global standard-kit hooks (the row reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, observedJobs: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyPanelInfo() {
  const store = createSnapshotStore({ activePanelId: null })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function mount() {
  const store = createFontRowStore().create()
  store.actions.sync({ text: 14, code: 11, terminal: 13 }, { text: '', code: '"Iosevka"', terminal: '' }, 0)
  const setFontFamily = vi.fn()
  const setFontSize = vi.fn()
  const props: FontSettingsGroupProps = {
    useSessions: emptySessions(),
    usePanelInfo: emptyPanelInfo(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setFontFamily,
    setFontSize,
  }
  render(<FontSettingsGroup {...props} />)
  return { setFontFamily, setFontSize, header: screen.getByRole('button', { name: 'More font settings' }) }
}

describe('FontSettingsGroup', () => {
  it('starts collapsed and toggles the font rows from the font-size row', () => {
    const g = mount()
    expect(screen.getByText('Font size')).toBeDefined()
    expect(g.header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(g.header)
    expect(g.header.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(g.header.getAttribute('aria-controls')!)).not.toBeNull()
    expect(screen.getAllByRole('textbox')).toHaveLength(3)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Code font' }).value).toBe('"Iosevka"')
    fireEvent.click(g.header)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('routes each row write to its role', () => {
    const g = mount()
    fireEvent.click(g.header)
    const terminal = screen.getByRole('textbox', { name: 'Terminal font' })
    fireEvent.change(terminal, { target: { value: 'Hack' } })
    fireEvent.blur(terminal)
    expect(g.setFontFamily).toHaveBeenCalledWith('terminal', '"Hack"')
    fireEvent.click(screen.getByRole('button', { name: 'Increase code font size' }))
    expect(g.setFontSize).toHaveBeenCalledWith('code', 12)
    fireEvent.click(screen.getByRole('button', { name: 'Decrease terminal font size' }))
    expect(g.setFontSize).toHaveBeenCalledWith('terminal', 12)
  })
})
