// @vitest-environment jsdom
/** Authorized-target listing of the remote-desktop guide entry. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { RemoteDesktopGuide } from '../src/client/RemoteDesktopGuide.tsx'
import type { RemoteDesktopGuideInjected } from '../src/client/face.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const GRANTS = [
  {
    id: 'g1', target: { nodeId: 'mac-mini' }, principal: 'u', level: 'control' as const,
    scope: { kind: 'machine' as const }, recording: false, grantedBy: 'admin', createdAt: 1,
  },
  {
    id: 'g2', target: { nodeId: 'win-1', desktop: 'display-0' }, principal: 'u', level: 'view' as const,
    scope: { kind: 'machine' as const }, recording: true, grantedBy: 'admin', createdAt: 2,
  },
]

function fixture(grants: typeof GRANTS | Promise<never>) {
  const listTargets = vi.fn<RemoteDesktopGuideInjected['listTargets']>().mockResolvedValue(grants as typeof GRANTS)
  const openTab = vi.fn()
  const props = {
    listTargets,
    useTabInfo: () => ({ tab: { actions: { openTab } } }),
    t: (key: keyof typeof en) => en[key],
    title: 'Remote desktop',
    kind: 'remoteDesktop',
  } as unknown as ComponentProps<typeof RemoteDesktopGuide>
  return { openTab, props }
}

it('lists the caller\'s authorized targets and opens the chosen one', async () => {
  const { openTab, props } = fixture(GRANTS)
  render(<RemoteDesktopGuide {...props} />)
  const target = await screen.findByText('mac-mini')
  expect(screen.getByText('win-1 · display-0')).toBeTruthy()
  expect(screen.getByText('Control')).toBeTruthy()
  expect(screen.getByText('View only · Recording')).toBeTruthy()
  fireEvent.click(target)
  expect(openTab).toHaveBeenCalledWith('remoteDesktop', {
    replaceTab: true, params: { nodeId: 'mac-mini' },
  })
})

it('shows the empty message when the caller has no live grants', async () => {
  const { props } = fixture([])
  render(<RemoteDesktopGuide {...props} />)
  await waitFor(() => expect(screen.getByText(en.targetsEmpty)).toBeTruthy())
})
