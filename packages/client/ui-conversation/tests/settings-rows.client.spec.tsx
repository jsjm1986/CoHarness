// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TranscriptViewRow, type TranscriptViewRowProps } from '../src/client/settings/TranscriptViewRow.tsx'
import { PerformanceUsageRow } from '../src/client/settings/PerformanceUsageRow.tsx'
import { LinkOpeningRow, type LinkOpeningRowProps } from '../src/client/settings/LinkOpeningRow.tsx'
import { TranscriptViewPolicy } from '../src/client/transcript-view.ts'
import { PerformanceUsagePolicy } from '../src/client/performance-usage.ts'
import { LinkOpeningPolicy } from '../src/client/link-opening.ts'
import type { ConversationSettings } from '../src/submission-settings.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, observedJobs: {}, currentAddress: undefined,
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }))
}

const readySection: ConversationSettings = {
  busyEnter: 'queue', chatContentWidth: 700, chatFontSize: 13,
  performanceUsage: 'detailed', linkOpening: 'sidebar',
}

describe('TranscriptViewRow', () => {
  it('selects a work-details mode through the policy and persists it', () => {
    const host = stubSettingsScope<ConversationSettings>()
    host.publish({ status: 'ready', writable: true, value: readySection })
    const policy = new TranscriptViewPolicy(host.scope)
    const props: TranscriptViewRowProps = {
      useSessions: emptySessions(),
      useWorkspaces: emptyWorkspaces(),
      useTranscriptView: bindSnapshotSelector(policy.mode),
      useSettings: bindSnapshotSelector(policy.settings),
      setTranscriptView: (mode) => { policy.setMode(mode) },
      t: makeTranslate(en),
    }
    render(<TranscriptViewRow {...props} />)
    expect(screen.getByText('Work details')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /Detailed/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }))
    expect(policy.mode.getSnapshot()).toBe('compact')
    expect(host.set).toHaveBeenCalledWith('transcriptView', 'compact')
    policy.dispose()
  })

  it('disables the selector while the durable scope is read-only', () => {
    const host = stubSettingsScope<ConversationSettings>()
    host.publish({ status: 'ready', writable: false, writableReason: 'provider', value: readySection })
    const policy = new TranscriptViewPolicy(host.scope)
    render(
      <TranscriptViewRow
        useSessions={emptySessions()}
        useWorkspaces={emptyWorkspaces()}
        useTranscriptView={bindSnapshotSelector(policy.mode)}
        useSettings={bindSnapshotSelector(policy.settings)}
        setTranscriptView={vi.fn()}
        t={makeTranslate(en)}
      />,
    )
    expect((screen.getByRole('button', { name: /Detailed/ }) as HTMLButtonElement | null)?.disabled).toBe(true)
    expect(screen.getByText('This deployment stores settings read-only.')).toBeDefined()
    policy.dispose()
  })
})

describe('PerformanceUsageRow', () => {
  it('switches detail levels through the policy', () => {
    const host = stubSettingsScope<ConversationSettings>()
    host.publish({ status: 'ready', writable: true, value: readySection })
    const policy = new PerformanceUsagePolicy(host.scope)
    render(
      <PerformanceUsageRow
        useSessions={emptySessions()}
        useWorkspaces={emptyWorkspaces()}
        usePerformanceUsage={bindSnapshotSelector(policy.mode)}
        useSettings={bindSnapshotSelector(policy.settings)}
        setPerformanceUsage={(mode) => { policy.setMode(mode) }}
        t={makeTranslate(en)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Detailed/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }))
    expect(policy.mode.getSnapshot()).toBe('compact')
    expect(host.set).toHaveBeenCalledWith('performanceUsage', 'compact')
    policy.dispose()
  })
})

describe('LinkOpeningRow', () => {
  function mount(browserAvailable = true) {
    const host = stubSettingsScope<ConversationSettings>()
    host.publish({ status: 'ready', writable: true, value: readySection })
    const policy = new LinkOpeningPolicy(host.scope)
    const props: LinkOpeningRowProps = {
      useSessions: emptySessions(),
      useWorkspaces: emptyWorkspaces(),
      useLinkOpening: bindSnapshotSelector(policy.destination),
      useBrowserAvailable: bindSnapshotSelector(createSnapshotStore(browserAvailable)),
      useSettings: bindSnapshotSelector(policy.settings),
      setLinkOpening: (destination) => { policy.setDestination(destination) },
      t: makeTranslate(en),
    }
    const view = render(<LinkOpeningRow {...props} />)
    return { policy, host, view }
  }

  it('hides itself when the assembly registers no Browser tab type', () => {
    const { view, policy } = mount(false)
    expect(view.container.firstChild).toBeNull()
    policy.dispose()
  })

  it('switches destinations through the policy', () => {
    const { policy, host } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Built-in browser/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New tab' }))
    expect(policy.destination.getSnapshot()).toBe('new-tab')
    expect(host.set).toHaveBeenCalledWith('linkOpening', 'new-tab')
    policy.dispose()
  })
})
