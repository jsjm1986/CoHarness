/** Center-only metadata, bounded paging and an explicit selected-computer value. */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AdminComputerContext, NodeAccessEntry } from '../../src/node-access.ts'
import { AdminRequestError, getAdminComputerContext, listNodeAccess } from './api.ts'
import { ComputerSelectorProvider } from './ComputerSelector.tsx'
import { PageHeader } from './components/ui.tsx'

vi.mock('./api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./api.ts')>(), getAdminComputerContext: vi.fn(), listNodeAccess: vi.fn(),
}))

const node: NodeAccessEntry = { nodeId: '61f22202-1c02-4a3c-8d34-f11222333444' as NodeAccessEntry['nodeId'],
  name: 'Computer B', revision: 2, status: 'connected', platform: 'linux', architecture: 'x64',
  lastSeenAt: null, leaseExpiresAt: null, executionReady: false }
const center: AdminComputerContext = { nodeId: '72f22202-1c02-4a3c-8d34-f11222333444' as AdminComputerContext['nodeId'],
  name: 'Main', forwardingEnabled: true }

beforeEach(() => {
  vi.mocked(getAdminComputerContext).mockResolvedValue(center)
  vi.mocked(listNodeAccess).mockResolvedValue({ items: [node], nextCursor: null })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

const trigger = () => screen.getByRole('button', { name: /^管理电脑：/u })
const choose = (name: string) => screen.findByRole('button', { name })
const refresh = () => screen.getByRole('button', { name: '刷新电脑列表' })

function picker(onSelect: (id?: NodeAccessEntry['nodeId']) => void, nodeId?: NodeAccessEntry['nodeId'], title = '用户管理') {
  return <ComputerSelectorProvider enabled onSelect={onSelect} nodeId={nodeId}><PageHeader key={title} title={title} /></ComputerSelectorProvider>
}

it('uses existing registered-computer metadata and passes one explicit selection to document navigation', async () => {
  const select = vi.fn()
  render(picker(select))
  expect(screen.queryByRole('button', { name: '刷新电脑列表' })).toBeNull()
  await userEvent.click(trigger())
  await waitFor(() => expect(refresh().hasAttribute('aria-disabled')).toBe(false))
  await userEvent.click(await choose('Computer B'))
  expect(select).toHaveBeenCalledExactlyOnceWith(node.nodeId)
  expect(screen.queryByRole('button', { name: '刷新电脑列表' })).toBeNull()
  expect(getAdminComputerContext).toHaveBeenCalledTimes(1)
  expect(listNodeAccess).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal))
})

it('loads the directory while center metadata is pending and permits metadata selection before connection readiness', async () => {
  let resolve!: (value: AdminComputerContext) => void
  vi.mocked(getAdminComputerContext).mockReturnValue(new Promise(done => { resolve = done }))
  render(picker(vi.fn()))
  await userEvent.click(trigger())
  const remote = await choose('Computer B') as HTMLButtonElement
  expect(remote.disabled).toBe(false)
  expect(refresh().getAttribute('aria-disabled')).toBe('true')
  await act(async () => { resolve(center) })
  expect(remote.disabled).toBe(false)
})

it('labels an explicit center address with its existing center option without navigating', async () => {
  const select = vi.fn()
  render(picker(select, center.nodeId))
  await userEvent.click(trigger())
  const local = await choose('Main 中心电脑')
  expect(local.getAttribute('aria-current')).toBe('true')
  expect(screen.queryByRole('button', { name: `电脑 ${center.nodeId.slice(0, 8)}` })).toBeNull()
  await userEvent.click(local)
  expect(select).not.toHaveBeenCalled()
  await userEvent.click(trigger())
  await userEvent.click(await choose('Computer B'))
  expect(select).toHaveBeenCalledExactlyOnceWith(node.nodeId)
})

it('retains the isolated target without offering it for new navigation or selecting a different computer', async () => {
  vi.mocked(listNodeAccess).mockResolvedValue({ items: [{ ...node, status: 'quarantined' }], nextCursor: null })
  const select = vi.fn()
  render(picker(select, node.nodeId))
  await userEvent.click(trigger())
  const option = await choose('Computer B 已隔离') as HTMLButtonElement
  expect(option.disabled).toBe(true)
  expect(option.getAttribute('aria-current')).toBe('true')
  expect(trigger().textContent).toBe('Computer B')
  expect(select).not.toHaveBeenCalled()
})

it('retains the explicit center address when its identity cannot be read', async () => {
  vi.mocked(getAdminComputerContext).mockRejectedValue(new Error('offline'))
  const select = vi.fn()
  render(picker(select, center.nodeId))
  await userEvent.click(trigger())
  await screen.findByText('无法读取中心电脑信息，请刷新重试')
  const name = `电脑 ${center.nodeId.slice(0, 8)}`
  expect(trigger().textContent).toBe(name)
  expect((await choose(name)).getAttribute('aria-current')).toBe('true')
  expect(select).not.toHaveBeenCalled()
})

it('keeps a selected computer visible when another bounded directory page is loaded', async () => {
  const other = { ...node, nodeId: center.nodeId, name: 'Computer C', status: 'disconnected' as const }
  vi.mocked(listNodeAccess)
    .mockResolvedValueOnce({ items: [node], nextCursor: other.nodeId })
    .mockResolvedValueOnce({ items: [other], nextCursor: null })
  render(picker(vi.fn(), node.nodeId))
  await userEvent.click(trigger())
  const more = await screen.findByRole('button', { name: '更多电脑' })
  await userEvent.click(more)
  const next = await choose('Computer C 未连接') as HTMLButtonElement
  expect(trigger().textContent).toBe('Computer B')
  expect((await choose('Computer B')).getAttribute('aria-current')).toBe('true')
  expect(next.disabled).toBe(false)
  expect(listNodeAccess).toHaveBeenLastCalledWith(other.nodeId, expect.any(AbortSignal))
  expect(listNodeAccess).toHaveBeenCalledTimes(2)
  expect(getAdminComputerContext).toHaveBeenCalledTimes(1)
})

it('retains known computers on a temporary directory failure and exposes refresh without replaying actions', async () => {
  vi.mocked(listNodeAccess).mockResolvedValueOnce({ items: [node], nextCursor: null }).mockRejectedValueOnce(new Error('offline'))
  render(picker(vi.fn(), node.nodeId))
  await userEvent.click(trigger())
  await choose('Computer B')
  await waitFor(() => expect(refresh().hasAttribute('aria-disabled')).toBe(false))
  await userEvent.click(refresh())
  await screen.findByText('无法读取电脑列表，请刷新重试')
  expect((await choose('Computer B')).getAttribute('aria-current')).toBe('true')
  expect(listNodeAccess).toHaveBeenCalledTimes(2)
})

it('clears unauthorized metadata while retaining the explicit selected address', async () => {
  vi.mocked(listNodeAccess).mockRejectedValue(new AdminRequestError(403, 'forbidden'))
  render(picker(vi.fn(), node.nodeId))
  await userEvent.click(trigger())
  await screen.findByText('没有读取电脑列表的权限')
  expect((await choose(`电脑 ${node.nodeId.slice(0, 8)}`)).getAttribute('aria-current')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Computer B' })).toBeNull()
})

it('permits metadata selection while forwarding is disabled and cancels only its own pending reads on unmount', async () => {
  vi.mocked(getAdminComputerContext).mockResolvedValue({ ...center, forwardingEnabled: false })
  const view = render(picker(vi.fn()))
  await userEvent.click(trigger())
  await screen.findByText('多电脑管理服务尚未启用')
  const remote = await choose('Computer B') as HTMLButtonElement
  expect(remote.disabled).toBe(false)
  const directorySignal = vi.mocked(listNodeAccess).mock.calls[0]![1]!
  const contextSignal = vi.mocked(getAdminComputerContext).mock.calls[0]![0]!
  view.unmount()
  expect(directorySignal.aborted).toBe(true)
  expect(contextSignal.aborted).toBe(true)
})

it('shares directory reads across replacement page titles', async () => {
  const onSelect = vi.fn()
  const view = render(picker(onSelect))
  await screen.findByRole('button', { name: '管理电脑：Main' })
  view.rerender(picker(onSelect, undefined, '文档'))
  expect(trigger().closest('header')?.querySelector('h1')?.textContent).toBe('文档')
  await userEvent.click(trigger())
  await choose('Computer B')
  expect(getAdminComputerContext).toHaveBeenCalledTimes(1)
  expect(listNodeAccess).toHaveBeenCalledTimes(1)
})
