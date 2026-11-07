// @vitest-environment jsdom
/** Consent-gated attach flow of the remote-desktop tab body. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { RemoteDesktopBody } from '../src/client/RemoteDesktopBody.tsx'
import type { RemoteDesktopInjected, RemoteDesktopScreen } from '../src/client/face.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const TARGET = { nodeId: 'node-1', desktop: 'display-0' }
const statusView = (consented: boolean) => ({
  target: TARGET, available: true, attachments: 0, level: 'control' as const, recording: true, consented,
})
const ATTACHMENT = {
  id: 'att-1',
  spec: { target: TARGET, level: 'control' as const, recording: true },
  url: 'ws://host/remote-desktop/stream?token=t1',
}

function fixture(consented: boolean) {
  const status = vi.fn<RemoteDesktopInjected['status']>().mockResolvedValue(statusView(consented))
  const confirm = vi.fn<RemoteDesktopInjected['confirm']>().mockResolvedValue(ATTACHMENT.spec)
  const attach = vi.fn<RemoteDesktopInjected['attach']>().mockResolvedValue(ATTACHMENT)
  const screen_: RemoteDesktopScreen = {
    disconnect: vi.fn(), sendCredentials: vi.fn(),
    setZoom: vi.fn(), setQuality: vi.fn(), sendCtrlAltDel: vi.fn(),
  }
  const openScreen = vi.fn<RemoteDesktopInjected['openScreen']>().mockReturnValue(screen_)
  const setPanelMode = vi.fn()
  const gate = new AbortController()
  type TabInfo = ReturnType<ComponentProps<typeof RemoteDesktopBody>['useTabInfo']>
  const info: TabInfo = {
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1' as TabInfo['panel']['id'] },
    tab: {
      id: 'tab-1' as TabInfo['tab']['id'],
      kind: 'remoteDesktop',
      contentId: 'sidebar://remoteDesktop',
      title: '',
      visible: true,
      signal: gate.signal,
      navigation: { address: 'sidebar://remoteDesktop', params: TARGET, revision: 1 },
      actions: {
        bindCommands: vi.fn(() => vi.fn()),
        openResource: vi.fn(),
        openTab: vi.fn(),
        setPanelMode,
        close: vi.fn(),
      },
    },
  }
  const useTabInfo: ComponentProps<typeof RemoteDesktopBody>['useTabInfo'] = () => info
  const props = {
    status, confirm, attach, openScreen,
    useTabInfo,
    t: (key: keyof typeof en, params?: Record<string, string>) => {
      let text: string = en[key]
      for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value)
      return text
    },
  }
  return { status, confirm, attach, openScreen, setPanelMode, screen: screen_, props }
}

const renderBody = (f: ReturnType<typeof fixture>) =>
  render(<RemoteDesktopBody {...(f.props as ComponentProps<typeof RemoteDesktopBody>)} />)

it('shows the consent card before attach and mounts the screen after confirm', async () => {
  const f = fixture(false)
  renderBody(f)
  await screen.findByText(en.consentTitle)
  expect(f.attach).not.toHaveBeenCalled()
  expect(screen.getByText(en.consentRecording)).toBeTruthy()
  await act(async () => { screen.getByRole('button', { name: en.consentAction }).click() })
  await waitFor(() => { expect(f.confirm).toHaveBeenCalledWith(TARGET, 'control', expect.any(AbortSignal)) })
  await waitFor(() => { expect(f.attach).toHaveBeenCalledWith(TARGET, 'control', expect.any(AbortSignal)) })
  await waitFor(() => {
    expect(f.openScreen).toHaveBeenCalledWith(
      expect.any(HTMLElement), ATTACHMENT.url, expect.objectContaining({ viewOnly: false }),
    )
  })
})

it('skips consent when the status already covers the grant set', async () => {
  const f = fixture(true)
  renderBody(f)
  await waitFor(() => { expect(f.attach).toHaveBeenCalled() })
  expect(f.confirm).not.toHaveBeenCalled()
})

it.each([false, true])('explains an unavailable desktop before consent or attach (consented=%s)', async (consented) => {
  const f = fixture(consented)
  f.status.mockResolvedValue({ ...statusView(consented), available: false })
  renderBody(f)
  await screen.findByText(en.unavailable)
  expect(f.confirm).not.toHaveBeenCalled()
  expect(f.attach).not.toHaveBeenCalled()
  expect(f.openScreen).not.toHaveBeenCalled()
  f.status.mockResolvedValue(statusView(consented))
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  if (!consented) await screen.findByText(en.consentTitle)
  else await waitFor(() => { expect(f.attach).toHaveBeenCalledOnce() })
})

it('disconnects the screen on unmount', async () => {
  const f = fixture(true)
  const view = renderBody(f)
  await waitFor(() => { expect(f.openScreen).toHaveBeenCalled() })
  view.unmount()
  expect(f.screen.disconnect).toHaveBeenCalled()
})

it('answers the server credentials challenge inside the tab', async () => {
  const f = fixture(true)
  renderBody(f)
  await waitFor(() => { expect(f.openScreen).toHaveBeenCalled() })
  const options = f.openScreen.mock.calls[0]![2]
  await act(async () => { options.onCredentialsRequired?.(['username', 'password']) })
  await screen.findByText(en.credentialsTitle)
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'operator' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'secret' } })
  await act(async () => { screen.getByRole('button', { name: en.credentialsAction }).click() })
  expect(f.screen.sendCredentials).toHaveBeenCalledWith({ username: 'operator', password: 'secret' })
})

it('asks the panel for fullscreen once the stream is live and visible', async () => {
  const f = fixture(true)
  renderBody(f)
  await waitFor(() => { expect(f.openScreen).toHaveBeenCalled() })
  expect(f.setPanelMode).toHaveBeenCalledExactlyOnceWith('fullscreen')
})

it('retunes the live screen from the zoom and quality chrome', async () => {
  const f = fixture(true)
  renderBody(f)
  await waitFor(() => { expect(f.openScreen).toHaveBeenCalled() })
  expect(f.screen.setZoom).toHaveBeenCalledWith('fit')
  expect(f.screen.setQuality).toHaveBeenCalledWith('balanced')
  fireEvent.click(screen.getByRole('tab', { name: en.zoomActual }))
  expect(f.screen.setZoom).toHaveBeenLastCalledWith('actual')
  fireEvent.click(screen.getByRole('button', { name: `${en.quality}: ${en.quality_balanced}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.quality_smooth }))
  expect(f.screen.setQuality).toHaveBeenLastCalledWith('smooth')
})

it('sends Ctrl+Alt+Delete and toggles the panel mode from the chrome', async () => {
  const f = fixture(true)
  renderBody(f)
  await waitFor(() => { expect(f.openScreen).toHaveBeenCalled() })
  f.setPanelMode.mockClear()
  fireEvent.click(screen.getByRole('button', { name: en.ctrlAltDel }))
  expect(f.screen.sendCtrlAltDel).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.fullscreen }))
  expect(f.setPanelMode).toHaveBeenCalledExactlyOnceWith('fullscreen')
})
