// @vitest-environment jsdom
/** Consent-gated attach flow of the remote-desktop tab body. */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { RemoteDesktopBody } from '../src/client/RemoteDesktopBody.tsx'
import type { RemoteDesktopInjected } from '../src/client/face.ts'
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
  const disconnect = vi.fn()
  const openScreen = vi.fn<RemoteDesktopInjected['openScreen']>().mockReturnValue({ disconnect })
  const gate = new AbortController()
  const useTabInfo = () => ({
    tab: { id: 'tab-1', signal: gate.signal, navigation: { params: TARGET } },
  })
  const props = {
    status, confirm, attach, openScreen,
    useTabInfo,
    t: (key: keyof typeof en, params?: Record<string, string>) => {
      let text: string = en[key]
      for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value)
      return text
    },
  }
  return { status, confirm, attach, openScreen, disconnect, props }
}

it('shows the consent card before attach and mounts the screen after confirm', async () => {
  const f = fixture(false)
  render(<RemoteDesktopBody {...(f.props as ComponentProps<typeof RemoteDesktopBody>)} />)
  await screen.findByText(en.consentTitle)
  expect(f.attach).not.toHaveBeenCalled()
  expect(screen.getByText(en.consentRecording)).toBeTruthy()
  await act(async () => { screen.getByRole('button', { name: en.consentAction }).click() })
  await waitFor(() => { expect(f.confirm).toHaveBeenCalledWith(TARGET, 'control', expect.any(AbortSignal)) })
  await waitFor(() => { expect(f.attach).toHaveBeenCalledWith(TARGET, 'control', expect.any(AbortSignal)) })
  await waitFor(() => { expect(f.openScreen).toHaveBeenCalledWith(expect.any(HTMLElement), ATTACHMENT.url, { viewOnly: false }) })
})

it('skips consent when the status already covers the grant set', async () => {
  const f = fixture(true)
  render(<RemoteDesktopBody {...(f.props as ComponentProps<typeof RemoteDesktopBody>)} />)
  await waitFor(() => { expect(f.attach).toHaveBeenCalled() })
  expect(f.confirm).not.toHaveBeenCalled()
})

it('disconnects the screen on unmount', async () => {
  const f = fixture(true)
  const view = render(<RemoteDesktopBody {...(f.props as ComponentProps<typeof RemoteDesktopBody>)} />)
  await waitFor(() => { expect(f.openScreen).toHaveBeenCalled() })
  view.unmount()
  expect(f.disconnect).toHaveBeenCalled()
})
