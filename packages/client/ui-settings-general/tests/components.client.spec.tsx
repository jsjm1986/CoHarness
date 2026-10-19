// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { GeneralSectionComponentProps } from '../src/client/GeneralSection.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import type { TriggerContentProps } from '../src/client/chrome.tsx'
import { SettingsDocumentAction } from '../src/client/SettingsDocumentAction.tsx'
import { DeveloperToolsRow } from '../src/client/DeveloperToolsRow.tsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsDocumentStore } from '../src/client/settings-document-store.ts'
import { HostReleasePrompt, type HostReleasePromptProps } from '../src/client/HostReleasePrompt.tsx'

/** Store over a real mirror derived from the same fake wire. */
function derivedDocumentStore(api: object) {
  const wire = api as never
  return new SettingsDocumentStore(wire, new SettingsDescribeMirror(wire))
}
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

// The seat's key domain is settings ∪ common; the stub answers from the
// package dictionary and falls back to the key like the real chain.
const t: TriggerContentProps['t'] = key => (en as Record<string, string>)[key] ?? key

// Global standard kit stubs: none of these components consume the hooks.
const unusedHook = (() => { throw new Error('unused by settings-general components') }) as never
const kit = { useSessions: unusedHook, useWorkspaces: unusedHook, usePanelInfo: unusedHook }

describe('chrome content', () => {
  it('TriggerContent renders the icon with the label in the wide column', () => {
    const { container } = render(<TriggerContent {...kit} wide t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('TriggerContent drops the label in the rail state', () => {
    const { container } = render(<TriggerContent {...kit} wide={false} t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('HeaderContent and CloseLabel render their translated text', () => {
    render(<HeaderContent {...kit} t={t} />)
    render(<CloseLabel {...kit} t={t} />)
    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.getByText('Close')).toBeTruthy()
  })
})

describe('GeneralSection', () => {
  function mount() {
    const renderSlot = vi.fn(
      ((key: string) => <div data-testid={`slot-${key}`} />) as GeneralSectionComponentProps['renderSlot'],
    )
    const props: GeneralSectionComponentProps = { ...kit, renderSlot, close: vi.fn() }
    const view = render(<GeneralSection {...props} />)
    return { view, renderSlot }
  }

  it('renders the item slot as the section body', () => {
    const { renderSlot } = mount()
    expect(renderSlot).toHaveBeenCalledWith('settings.general.item', {})
    expect(screen.getByTestId('slot-settings.general.item')).toBeTruthy()
  })
})

describe('DeveloperToolsRow', () => {
  function mount(enabled: boolean, setEnabled = vi.fn(async (_next: boolean) => {})) {
    const store = createSnapshotStore(enabled)
    const view = render(<DeveloperToolsRow {...{
      ...kit,
      useDeveloperTools: bindSnapshotSelector(store),
      setEnabled,
      t,
    }} />)
    return { view, store, setEnabled }
  }

  it('mirrors the accepted value and saves a flip through the shared writer', async () => {
    const { store, setEnabled } = mount(true)
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    expect(setEnabled).toHaveBeenCalledWith(false)
    await waitFor(() => { expect(toggle).toHaveProperty('disabled', false) })

    // An external accepted change moves the switch.
    act(() => { store.set(false) })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('reports a refused save and clears on the next attempt', async () => {
    const setEnabled = vi.fn(async (_next: boolean): Promise<void> => { throw new Error('conflict') })
    mount(false, setEnabled)
    const toggle = screen.getByRole('switch')

    fireEvent.click(toggle)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['developerTools.error']) })

    setEnabled.mockImplementation(async () => {})
    fireEvent.click(toggle)
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })
})

describe('SettingsDocumentAction', () => {
  it('appears only for a file-backed provider and requests its Host-owned document', async () => {
    const openDocument = vi.fn(() => Promise.resolve({
      rpcId: 'document-open' as never,
      result: { ok: true as const, value: { opened: true as const } },
    }))
    const controller = derivedDocumentStore({
      settings: {
        describe: vi.fn(() => Promise.resolve({
          rpcId: 'document-action' as never,
          result: {
            ok: true as const,
            value: { writable: true, hasDocument: true, namespaces: [] },
          },
        })),
        openDocument,
      },
    })
    render(<SettingsDocumentAction
      {...kit}
      t={t}
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
    />)
    const action = await screen.findByRole('button', { name: 'Open configuration file' })
    fireEvent.click(action)
    await waitFor(() => { expect(openDocument).toHaveBeenCalledWith({}) })
  })

  it('stays absent without a document and follows a mirror refresh to available', async () => {
    const describe = vi.fn()
      .mockResolvedValueOnce({
        rpcId: 'document-action-absent' as never,
        result: { ok: true as const, value: { writable: true, hasDocument: false, namespaces: [] } },
      })
      .mockResolvedValueOnce({
        rpcId: 'document-action-ready' as never,
        result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
      })
    const wire = { settings: { describe, openDocument: vi.fn() } } as never
    const mirror = new SettingsDescribeMirror(wire)
    const controller = new SettingsDocumentStore(wire, mirror)
    const first = render(<SettingsDocumentAction
      {...kit}
      t={t}
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
    />)
    await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('unavailable') })
    expect(screen.queryByRole('button', { name: 'Open configuration file' })).toBeNull()
    first.unmount()
    render(<SettingsDocumentAction
      {...kit}
      t={t}
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
    />)
    // A remount alone re-reads nothing; availability moves with the mirror's
    // own refresh (a document commit or reconnect in production).
    await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('unavailable') })
    expect(describe).toHaveBeenCalledTimes(1)
    await mirror.load()
    expect(await screen.findByRole('button', { name: 'Open configuration file' })).toBeTruthy()
    expect(describe).toHaveBeenCalledTimes(2)
  })

  it('keeps the action available and reports a native-open failure', async () => {
    const controller = derivedDocumentStore({
      settings: {
        describe: vi.fn(() => Promise.resolve({
          rpcId: 'document-action' as never,
          result: {
            ok: true as const,
            value: { writable: true, hasDocument: true, namespaces: [] },
          },
        })),
        openDocument: vi.fn(() => Promise.resolve({
          rpcId: 'document-open-failed' as never,
          result: { ok: false as const, error: { code: 'internal' as const, message: 'xdg-open missing', details: {} } },
        })),
      },
    })
    render(<SettingsDocumentAction
      {...kit}
      t={t}
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
    />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open configuration file' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not open configuration file')
    expect(screen.getByRole('button', { name: 'Open configuration file' })).toBeTruthy()
  })
})

describe('Host release change confirmation', () => {
  type Release = { version: string; commit?: string }
  type Change = { page: Release | undefined; previous: Release | undefined; host: Release | undefined } | undefined
  function prompt(change: Change) {
    const dismissRelease = vi.fn()
    const reloadPage = vi.fn()
    const props: HostReleasePromptProps = {
      ...kit,
      t: key => (en as Record<string, string>)[key] ?? key,
      useReleaseChange: select => select(change),
      dismissRelease,
      reloadPage,
    }
    return { dismissRelease, reloadPage, view: render(<HostReleasePrompt {...props} />) }
  }

  it('stays hidden while no release change is announced', () => {
    prompt(undefined)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the service and page transitions and either reloads or keeps the page', () => {
    const { dismissRelease, reloadPage } = prompt({
      page: { version: '0.2.1' }, previous: { version: '0.2.2' }, host: { version: '0.2.3', commit: 'abc1234' },
    })
    const dialog = screen.getByRole('dialog', { name: 'Service version changed' })
    // Changed versions show only the versions.
    expect(dialog.textContent).toContain('Service0.2.20.2.3Page0.2.10.2.3')
    expect(dialog.textContent).toContain(en['hostRelease.description'])
    // The dialog opens without a user gesture; initial focus keeps the page.
    expect(document.activeElement?.textContent).toBe('Not now')
    fireEvent.click(screen.getByRole('button', { name: 'Reload to load the new version' }))
    expect(reloadPage).toHaveBeenCalledOnce()
    expect(dismissRelease).not.toHaveBeenCalled()
    const keep = screen.getAllByRole('button', { name: 'Not now' })
    // The footer action and the dialog's close control both keep the page.
    expect(keep).toHaveLength(2)
    for (const button of keep) fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dismissRelease).toHaveBeenCalledTimes(3)
  })

  it('shows commits for a transition within one version and labels what the Host did not publish', () => {
    prompt({
      page: { version: '0.2.0' },
      previous: { version: '0.2.1', commit: 'aaaaaaa' },
      host: { version: '0.2.1', commit: 'bbbbbbb' },
    })
    expect(screen.getByRole('dialog').textContent).toContain('Serviceaaaaaaabbbbbbb' + 'Page0.2.00.2.1')
  })
})
