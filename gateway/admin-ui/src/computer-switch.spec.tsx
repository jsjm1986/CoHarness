/** Computer switching retains the current route and protects its unsaved form. */
import { useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { AdminLink } from './admin-navigation.tsx'
import { adminComputerRequestUrl } from './computer-target.ts'
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
      <AdminLink to="/users/24">Another user</AdminLink>
    </>
  },
}))
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/admin/') })

async function selectComputer(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /^管理电脑：/u }))
  fireEvent.click(await screen.findByRole('button', { name }))
}

async function traverseHistory(delta: number, observe?: () => void): Promise<void> {
  await act(async () => {
    const observed = new Promise<void>(resolve => {
      window.addEventListener('popstate', () => { observe?.(); resolve() }, { once: true, capture: true })
    })
    window.history.go(delta)
    await observed
  })
}

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

it('preserves the draft and both directions of the browser history across computers', async () => {
  vi.mocked(getAdminComputerContext).mockResolvedValue({ nodeId: center, name: 'Center', forwardingEnabled: true })
  vi.mocked(listNodeAccess).mockResolvedValue({ items: [{ nodeId: secondary, name: 'Secondary', revision: 1,
    status: 'connected', platform: 'linux', architecture: 'arm64', lastSeenAt: null, leaseExpiresAt: null, executionReady: false }], nextCursor: null })
  const centralPath = '/admin/users/23?from=qa#quota'
  const remotePath = `/admin/computers/${secondary}/users/23?from=qa#quota`
  window.history.replaceState({}, '', centralPath)
  render(<App />)
  await screen.findByRole('textbox', { name: 'Unsaved quota' })
  await selectComputer('Secondary')
  await screen.findByRole('textbox', { name: 'Unsaved quota' })
  expect(screen.getByRole('link', { name: 'Another user' }).getAttribute('href')).toBe(`/admin/computers/${secondary}/users/24`)
  await selectComputer('Center 中心电脑')
  await screen.findByRole('textbox', { name: 'Unsaved quota' })
  await traverseHistory(-1)
  expect(window.location.href).toBe(new URL(remotePath, window.location.origin).href)
  const entries = window.history.length
  const input = await screen.findByRole('textbox', { name: 'Unsaved quota' })
  fireEvent.change(input, { target: { value: '98765' } })

  for (const delta of [-1, 1]) {
    const during = { browser: '', request: '' }
    await traverseHistory(delta, () => {
      during.browser = window.location.pathname
      during.request = adminComputerRequestUrl('/admin/api/users/23')
    })
    expect(during).toEqual({ browser: '/admin/users/23', request: `/admin/api/users/23?dshNode=${secondary}` })
    const dialog = await screen.findByRole('dialog', { name: '保留当前编辑' })
    expect(within(dialog).getByRole('link', { name: '在新标签页打开' }).getAttribute('href')).toBe(centralPath)
    await waitFor(() => expect(window.location.href).toBe(new URL(remotePath, window.location.origin).href))
    expect(screen.getByRole('textbox', { name: 'Unsaved quota' })).toBe(input)
    expect(input).toHaveProperty('value', '98765')
    expect(window.history.length).toBe(entries)
    fireEvent.click(within(dialog).getByRole('button', { name: '留在当前页面' }))
    expect(screen.queryByRole('dialog', { name: '保留当前编辑' })).toBeNull()
  }

  fireEvent.change(input, { target: { value: 'baseline' } })
  await traverseHistory(1)
  expect(window.location.href).toBe(new URL(centralPath, window.location.origin).href)
  await traverseHistory(-1)
  expect(window.location.href).toBe(new URL(remotePath, window.location.origin).href)
  await traverseHistory(-1)
  expect(window.location.href).toBe(new URL(centralPath, window.location.origin).href)
})

it('renders the invalid-computer notice when clean popstate lands on a malformed computer URL', async () => {
  vi.mocked(getAdminComputerContext).mockResolvedValue({ nodeId: center, name: 'Center', forwardingEnabled: true })
  vi.mocked(listNodeAccess).mockResolvedValue({ items: [], nextCursor: null })
  window.history.replaceState({}, '', '/admin/users/23')
  render(<App />)
  await screen.findByRole('textbox', { name: 'Unsaved quota' })
  window.history.replaceState({}, '', '/admin/computers/not-a-uuid/users/23')
  fireEvent(window, new PopStateEvent('popstate'))
  expect((await screen.findByRole('alert')).textContent).toBe('电脑选择无效，请重新选择')
})
