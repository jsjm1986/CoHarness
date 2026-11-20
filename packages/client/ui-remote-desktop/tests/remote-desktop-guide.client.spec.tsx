// @vitest-environment jsdom
/** Authorized-target menu of the remote-desktop guide entry. */
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
  } as ComponentProps<typeof RemoteDesktopGuide>
  return { openTab, props }
}

it('lists the caller\'s authorized targets in the menu and opens the chosen one', async () => {
  const { openTab, props } = fixture(GRANTS)
  render(<RemoteDesktopGuide {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.connectDescription }))
  const target = await screen.findByText('mac-mini · Control')
  expect(screen.getByText('win-1 · display-0 · View only · Recording')).toBeTruthy()
  fireEvent.click(target)
  expect(openTab).toHaveBeenCalledWith('remoteDesktop', {
    replaceTab: true, params: { nodeId: 'mac-mini' },
  })
})

it('shows an empty-state explanation without an unavailable menu action', async () => {
  const { props } = fixture([])
  render(<RemoteDesktopGuide {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.connectDescription }))
  await waitFor(() => { expect(screen.getByText(en.targetsEmpty)).toBeTruthy() })
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  expect(screen.getByText(en.targetsEmpty).closest('button')).toBeNull()
})

it('keeps discovery feedback readable and exposes Retry as the only action on failure', async () => {
  const { props } = fixture([])
  const pending = Promise.withResolvers<never>()
  const listTargets = vi.fn<RemoteDesktopGuideInjected['listTargets']>()
    .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(GRANTS)
  render(<RemoteDesktopGuide {...props} listTargets={listTargets} />)
  fireEvent.click(screen.getByRole('button', { name: en.connectDescription }))
  expect(screen.getByText(en.targetsLoading).closest('button')).toBeNull()
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  pending.reject(new Error('Unavailable catalog'))
  expect(await screen.findByRole('status')).toHaveProperty('textContent', en.targetsFailed)
  const retry = screen.getByRole('menuitem', { name: en.retry })
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  fireEvent.click(retry)
  await screen.findByRole('menuitem', { name: 'mac-mini · Control' })
  expect(screen.queryByText(en.targetsFailed)).toBeNull()
})
