/** Center-only metadata, bounded paging and an explicit selected-computer value. */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AdminComputerContext, NodeAccessEntry } from '../../src/node-access.ts'
import { AdminRequestError, getAdminComputerContext, listNodeAccess } from './api.ts'
import { ComputerSelector } from './ComputerSelector.tsx'

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

it('uses existing registered-computer metadata and passes one explicit selection to document navigation', async () => {
  const select = vi.fn()
  render(<ComputerSelector onSelect={select} />)
  await screen.findByRole('option', { name: 'Computer B' })
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新电脑列表' }) as HTMLButtonElement).disabled).toBe(false))
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '管理电脑' }), node.nodeId)
  expect(select).toHaveBeenCalledExactlyOnceWith(node.nodeId)
  expect(getAdminComputerContext).toHaveBeenCalledTimes(1)
  expect(listNodeAccess).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal))
})

it('loads the directory while center metadata is pending and permits metadata selection before connection readiness', async () => {
  let resolve!: (value: AdminComputerContext) => void
  vi.mocked(getAdminComputerContext).mockReturnValue(new Promise(done => { resolve = done }))
  render(<ComputerSelector onSelect={vi.fn()} />)
  const remote = await screen.findByRole('option', { name: 'Computer B' }) as HTMLOptionElement
  expect(remote.disabled).toBe(false)
  expect((screen.getByRole('button', { name: '刷新电脑列表' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { resolve(center) })
  expect(remote.disabled).toBe(false)
})

it('labels an explicit center address with its existing center option without navigating', async () => {
  const select = vi.fn()
  render(<ComputerSelector nodeId={center.nodeId} onSelect={select} />)
  const local = await screen.findByRole('option', { name: '中心电脑 · Main' }) as HTMLOptionElement
  expect(local.selected).toBe(true)
  expect(screen.queryByRole('option', { name: `电脑 ${center.nodeId.slice(0, 8)}` })).toBeNull()
  expect(screen.getAllByRole('option')).toHaveLength(2)
  expect(select).not.toHaveBeenCalled()
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '管理电脑' }), node.nodeId)
  expect(select).toHaveBeenCalledExactlyOnceWith(node.nodeId)
})

it('retains the explicit center address when its identity cannot be read', async () => {
  vi.mocked(getAdminComputerContext).mockRejectedValue(new Error('offline'))
  const select = vi.fn()
  render(<ComputerSelector nodeId={center.nodeId} onSelect={select} />)
  await screen.findByText('无法读取中心电脑信息，请刷新重试')
  expect((screen.getByRole('combobox', { name: '管理电脑' }) as HTMLSelectElement).value).toBe(center.nodeId)
  expect(screen.getByRole('option', { name: `电脑 ${center.nodeId.slice(0, 8)}` })).toBeTruthy()
  expect(select).not.toHaveBeenCalled()
})

it('keeps a selected computer visible when another bounded directory page is loaded', async () => {
  const other = { ...node, nodeId: center.nodeId, name: 'Computer C', status: 'disconnected' as const }
  vi.mocked(listNodeAccess)
    .mockResolvedValueOnce({ items: [node], nextCursor: other.nodeId })
    .mockResolvedValueOnce({ items: [other], nextCursor: null })
  render(<ComputerSelector nodeId={node.nodeId} onSelect={vi.fn()} />)
  const more = await screen.findByRole('button', { name: '更多电脑' })
  await userEvent.click(more)
  await screen.findByRole('option', { name: 'Computer C · 未连接' })
  expect((screen.getByRole('combobox', { name: '管理电脑' }) as HTMLSelectElement).value).toBe(node.nodeId)
  expect(screen.getByRole('option', { name: 'Computer B' })).toBeTruthy()
  expect((screen.getByRole('option', { name: 'Computer C · 未连接' }) as HTMLOptionElement).disabled).toBe(false)
  expect(listNodeAccess).toHaveBeenLastCalledWith(other.nodeId, expect.any(AbortSignal))
  expect(listNodeAccess).toHaveBeenCalledTimes(2)
  expect(getAdminComputerContext).toHaveBeenCalledTimes(1)
})

it('retains known computers on a temporary directory failure and exposes refresh without replaying actions', async () => {
  vi.mocked(listNodeAccess).mockResolvedValueOnce({ items: [node], nextCursor: null }).mockRejectedValueOnce(new Error('offline'))
  render(<ComputerSelector nodeId={node.nodeId} onSelect={vi.fn()} />)
  await screen.findByRole('option', { name: 'Computer B' })
  await userEvent.click(screen.getByRole('button', { name: '刷新电脑列表' }))
  await screen.findByText('无法读取电脑列表，请刷新重试')
  expect(screen.getByRole('option', { name: 'Computer B' })).toBeTruthy()
  expect((screen.getByRole('combobox', { name: '管理电脑' }) as HTMLSelectElement).value).toBe(node.nodeId)
  expect(listNodeAccess).toHaveBeenCalledTimes(2)
})

it('clears unauthorized metadata while retaining the explicit selected address', async () => {
  vi.mocked(listNodeAccess).mockRejectedValue(new AdminRequestError(403, 'forbidden'))
  render(<ComputerSelector nodeId={node.nodeId} onSelect={vi.fn()} />)
  await screen.findByText('没有读取电脑列表的权限')
  expect((screen.getByRole('combobox', { name: '管理电脑' }) as HTMLSelectElement).value).toBe(node.nodeId)
  expect(screen.getByRole('option', { name: `电脑 ${node.nodeId.slice(0, 8)}` })).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'Computer B' })).toBeNull()
})

it('permits metadata selection while forwarding is disabled and cancels only its own pending reads on unmount', async () => {
  vi.mocked(getAdminComputerContext).mockResolvedValue({ ...center, forwardingEnabled: false })
  const view = render(<ComputerSelector onSelect={vi.fn()} />)
  await screen.findByText('多电脑管理服务尚未启用')
  const remote = await screen.findByRole('option', { name: 'Computer B' }) as HTMLOptionElement
  expect(remote.disabled).toBe(false)
  const directorySignal = vi.mocked(listNodeAccess).mock.calls[0]![1]!
  const contextSignal = vi.mocked(getAdminComputerContext).mock.calls[0]![0]!
  view.unmount()
  expect(directorySignal.aborted).toBe(true)
  expect(contextSignal.aborted).toBe(true)
})
