/** Computer switching retains the current route and protects its unsaved form. */
import { useState, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { getAdminComputerContext, listNodeAccess } from './api.ts'
import { PageHeader } from './components/ui.tsx'
import { usePendingEdits } from './pending-edits.tsx'
import type { RuntimeNodeId } from '../../src/runtime-catalog.ts'

const secondary = '10000000-0000-4000-8000-000000000002' as RuntimeNodeId
const center = '10000000-0000-4000-8000-000000000001' as RuntimeNodeId
vi.mock('./deployment-context.tsx', () => ({
  DeploymentContextProvider: ({ children }: { children: ReactNode }) => children,
  useDeploymentContext: () => ({ value: { scope: 'organization' }, error: false }),
}))
vi.mock('./api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./api.ts')>(),
  getAdminComputerContext: vi.fn(),
  listNodeAccess: vi.fn(),
}))
vi.mock('./pages/UserDetailPage.tsx', () => ({
  UserDetailPage: () => {
    const [value, setValue] = useState('baseline')
    usePendingEdits(value !== 'baseline')
    return <>
      <PageHeader title="User quota" />
      <input aria-label="Unsaved quota" value={value} onChange={event => setValue(event.target.value)} />
    </>
  },
}))
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/admin/') })

it.each([
  { source: '/admin/users/23', button: 'Secondary', target: `/admin/computers/${secondary}/users/23` },
  { source: `/admin/computers/${secondary}/users/23`, button: 'Center 中心电脑', target: '/admin/users/23' },
])('keeps the exact user route and draft when switching from $source', async ({ source, button, target }) => {
  vi.mocked(getAdminComputerContext).mockResolvedValue({ nodeId: center, name: 'Center', forwardingEnabled: true })
  vi.mocked(listNodeAccess).mockResolvedValue({ items: [{ nodeId: secondary, name: 'Secondary', revision: 1,
    status: 'connected', platform: 'linux', architecture: 'arm64', lastSeenAt: null, leaseExpiresAt: null, executionReady: false }], nextCursor: null })
  window.history.replaceState({}, '', `${source}?from=qa#quota`)
  render(<App />)
  const input = await screen.findByRole('textbox', { name: 'Unsaved quota' })
  fireEvent.change(input, { target: { value: '12345' } })
  fireEvent.click(screen.getByRole('button', { name: /^管理电脑：/u }))
  fireEvent.click(await screen.findByRole('button', { name: button }))
  const dialog = screen.getByRole('dialog', { name: '保留当前编辑' })
  expect(within(dialog).getByRole('link', { name: '在新标签页打开' }).getAttribute('href')).toBe(`${target}?from=qa#quota`)
  fireEvent.click(within(dialog).getByRole('button', { name: '留在当前页面' }))
  expect(window.location.pathname).toBe(source)
  expect(screen.getByRole('textbox', { name: 'Unsaved quota' })).toBe(input)
  expect(input).toHaveProperty('value', '12345')
})

it('switches computers in-SPA without a full page reload or directory refetch when there are no pending edits', async () => {
  vi.mocked(getAdminComputerContext).mockClear()
  vi.mocked(listNodeAccess).mockClear()
  vi.mocked(getAdminComputerContext).mockResolvedValue({ nodeId: center, name: 'Center', forwardingEnabled: true })
  vi.mocked(listNodeAccess).mockResolvedValue({ items: [{ nodeId: secondary, name: 'Secondary', revision: 1,
    status: 'connected', platform: 'linux', architecture: 'arm64', lastSeenAt: null, leaseExpiresAt: null, executionReady: false }], nextCursor: null })
  const assign = vi.spyOn(window.location, 'assign')
  try {
    window.history.replaceState({}, '', '/admin/users/23?from=qa#quota')
    render(<App />)
    await screen.findByRole('textbox', { name: 'Unsaved quota' })
    fireEvent.click(screen.getByRole('button', { name: /^管理电脑：/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Secondary' }))
    expect(assign).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`/admin/computers/${secondary}/users/23`)
    expect(window.location.search).toBe('?from=qa')
    expect(window.location.hash).toBe('#quota')
    await screen.findByRole('textbox', { name: 'Unsaved quota' })
    expect(vi.mocked(getAdminComputerContext)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(listNodeAccess)).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '管理电脑：Secondary' })).toBeTruthy()
  } finally {
    assign.mockRestore()
  }
})
