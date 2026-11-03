/** Recovery keeps the selected computer, allocation and last confirmed data visible. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { RuntimeAllocationPolicyEditor } from './RuntimeAllocationPolicyEditor.tsx'
import { UserComputerPermissions } from './UserComputerPermissions.tsx'
import { UserRuntimePanel } from './UserRuntimePanel.tsx'
import { runtimeFixture, runtimePageFixture } from './runtime-fixture.ts'
import { deploymentContextSchema } from '../../../src/deployment-protocol.ts'

vi.mock('../api.ts', () => ({
  getRuntimeAllocationPolicy: vi.fn(), saveRuntimeAllocationPolicy: vi.fn(),
  listUserComputerPermissions: vi.fn(), saveUserComputerPermission: vi.fn(),
  getAdminComputerContext: vi.fn(), listUserRuntimes: vi.fn(), allocateUserRuntime: vi.fn(), operateRuntime: vi.fn(),
}))
const single = deploymentContextSchema.parse({ mode: 'single', revision: '0',
  entry: { nodeId: '10000000-0000-4000-8000-000000000001', name: 'Computer A' }, primary: null,
  scope: 'local', role: 'standalone', refreshAfterMs: 30000, legacyMigrationRequired: false })
const multi = deploymentContextSchema.parse({ ...single, mode: 'multi', revision: '1', scope: 'organization', role: 'primary',
  primary: { ...single.entry, origin: 'https://primary.test' } })
let mode: 'single' | 'multi' = 'multi'
vi.mock('../deployment-context.tsx', () => ({ useDeploymentContext: () => ({
  value: mode === 'single' ? { ...single, entry: { ...single.entry, nodeId: runtime.node.id } } : multi, error: false, refresh: async () => {},
}) }))
const runtime = runtimeFixture('user', 1)
const computer: api.AdminComputerPermission = { nodeId: runtime.node.id, name: 'Computer A', status: 'active', enabled: true, revision: '1' }
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  mode = 'multi'
  vi.mocked(api.getAdminComputerContext).mockResolvedValue({ nodeId: runtime.node.id, name: computer.name, forwardingEnabled: true })
  vi.mocked(api.listUserRuntimes).mockResolvedValue(runtimePageFixture('user', 1))
  vi.mocked(api.getRuntimeAllocationPolicy).mockResolvedValue({ maxTotal: 8, maxPerNode: 4, revision: '1', source: 'user' })
  vi.mocked(api.listUserComputerPermissions).mockResolvedValue({ items: [computer], nextCursor: null })
})

it('keeps local Runtime controls and grants available without computer labels in single mode', async () => {
  mode = 'single'
  render(<><UserRuntimePanel userId={1} /><UserComputerPermissions userId={1} /></>)
  expect(await screen.findByRole('table')).toBeTruthy()
  expect(screen.queryByRole('columnheader', { name: '电脑' })).toBeNull()
  expect(screen.queryByText('Computer A')).toBeNull()
  expect(await screen.findByRole('checkbox', { name: '允许使用' })).toHaveProperty('checked', true)
  expect(screen.getByText('当前环境使用权限')).toBeTruthy()
  expect(within(screen.getByRole('table')).getByRole('button', { name: '停止' })).toBeTruthy()
})

it('filters retained foreign grants and blocks an open remote lifecycle confirmation when aggregation closes', async () => {
  const remote = { ...runtime, id: '10000000-0000-4000-8000-000000000002' as api.RuntimeId,
    node: { ...runtime.node, id: 'node-b' as api.RuntimeNodeId, name: 'Computer B' } }
  vi.mocked(api.listUserRuntimes).mockResolvedValue({ items: [runtime, remote], nextCursor: null })
  vi.mocked(api.listUserComputerPermissions).mockResolvedValue({ items: [computer,
    { ...computer, nodeId: remote.node.id, name: remote.node.name }], nextCursor: null })
  const content = <><UserRuntimePanel userId={1} /><UserComputerPermissions userId={1} /></>
  const view = render(content)
  const row = await screen.findByRole('row', { name: new RegExp(remote.id) })
  await userEvent.click(within(row).getByRole('button', { name: '停止' }))
  mode = 'single'
  view.rerender(<><UserRuntimePanel userId={1} /><UserComputerPermissions userId={1} /></>)
  const dialog = screen.getByRole('dialog', { name: '确认停止' })
  expect(dialog.textContent).toContain(remote.id)
  expect(within(dialog).getByRole('button', { name: '停止' })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('row', { name: new RegExp(remote.id) })).toBeNull()
  await waitFor(() => expect(screen.getAllByRole('checkbox', { name: '允许使用' })).toHaveLength(1))
  expect(api.operateRuntime).not.toHaveBeenCalled()
})

it('reports a lifecycle failure inside the still-open confirmation with its original Runtime identity', async () => {
  vi.mocked(api.operateRuntime).mockRejectedValue(new Error('Computer A is unavailable'))
  render(<UserRuntimePanel userId={1} />)
  const table = await screen.findByRole('table')
  await userEvent.click(within(table).getByRole('button', { name: '停止' }))
  const dialog = screen.getByRole('dialog', { name: '确认停止' })
  await userEvent.click(within(dialog).getByRole('button', { name: '停止' }))
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Computer A is unavailable')
  expect(dialog.textContent).toContain(runtime.id)
  expect(within(dialog).getByRole('button', { name: '停止' })).toHaveProperty('disabled', true)
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveProperty('disabled', false)
  expect(api.operateRuntime).toHaveBeenCalledExactlyOnceWith(runtime, 'stop')
})

it('keeps all four exact-Runtime actions available in the existing mobile item layout', async () => {
  render(<UserRuntimePanel userId={1} />)
  const item = await screen.findByRole('article')
  expect(item.textContent).toContain(runtime.id)
  expect(within(item).getAllByRole('button', { name: /^(启动|停止|重启|退役)$/ })).toHaveLength(4)
  await userEvent.click(within(item).getByRole('button', { name: '重启' }))
  expect(screen.getByRole('dialog', { name: '确认重启' }).textContent).toContain(`${computer.name} · ${runtime.id} · 代次 3`)
})

it('shows allocation progress and preserves the request identity when preparation needs a retry', async () => {
  const pending = Promise.withResolvers<api.RuntimeAllocationReceipt>()
  vi.mocked(api.allocateUserRuntime).mockReturnValueOnce(pending.promise).mockImplementationOnce(async (userId, nodeId, requestId) => ({ userId, nodeId, requestId, runtimeId: runtime.id, status: 'allocated' }))
  render(<UserRuntimePanel userId={1} />)
  const allocate = screen.getByRole('button', { name: '在当前电脑分配 Runtime' })
  await waitFor(() => expect(allocate).toHaveProperty('disabled', false))
  await userEvent.click(allocate)
  expect(allocate.getAttribute('aria-busy')).toBe('true')
  const first = vi.mocked(api.allocateUserRuntime).mock.calls[0]!
  await act(async () => { pending.resolve({ userId: 1, nodeId: computer.nodeId, requestId: first[2], runtimeId: runtime.id, status: 'preparing' }) })
  await userEvent.click(await screen.findByRole('button', { name: '重试本次分配' }))
  await waitFor(() => expect(api.allocateUserRuntime).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.allocateUserRuntime).mock.calls[1]).toEqual(first)
  expect(await screen.findByText(`已分配 Runtime：${runtime.id}`)).toBeTruthy()
})

it('retains the computer grant after an unconfirmed save and refreshes without replaying the mutation', async () => {
  vi.mocked(api.saveUserComputerPermission).mockRejectedValue(new TypeError('network interrupted'))
  render(<UserComputerPermissions userId={1} />)
  const toggle = await screen.findByRole('checkbox', { name: 'Computer A · 允许使用' })
  await userEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '授权变更未确认，请刷新电脑权限后再操作')
  expect(toggle).toHaveProperty('checked', true)
  expect(toggle).toHaveProperty('disabled', true)
  vi.mocked(api.listUserComputerPermissions).mockResolvedValue({ items: [{ ...computer, enabled: false, revision: '2' }], nextCursor: null })
  await userEvent.click(screen.getByRole('button', { name: '刷新电脑权限' }))
  await waitFor(() => expect(toggle).toHaveProperty('disabled', false))
  expect(toggle).toHaveProperty('checked', false)
  expect(api.saveUserComputerPermission).toHaveBeenCalledTimes(1)
})

it('retains edited limits after an unconfirmed save and requires an explicit refresh', async () => {
  vi.mocked(api.saveRuntimeAllocationPolicy).mockRejectedValue(new TypeError('network interrupted'))
  render(<RuntimeAllocationPolicyEditor userId={1} />)
  const total = await screen.findByRole('spinbutton', { name: '总配额' })
  fireEvent.change(total, { target: { value: '12' } })
  await userEvent.click(screen.getByRole('button', { name: '保存 Runtime 配额' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '保存未确认，请刷新后再修改')
  expect(total).toHaveProperty('value', '12')
  expect(screen.getByRole('button', { name: '保存 Runtime 配额' })).toHaveProperty('disabled', true)
  await userEvent.click(screen.getByRole('button', { name: '刷新配额' }))
  await waitFor(() => expect(total).toHaveProperty('disabled', false))
  expect(total).toHaveProperty('value', '8')
  expect(api.saveRuntimeAllocationPolicy).toHaveBeenCalledTimes(1)
})

it('associates invalid limits with their inputs and keeps the mutation disabled', async () => {
  render(<RuntimeAllocationPolicyEditor userId={1} />)
  const perNode = await screen.findByRole('spinbutton', { name: '每台电脑配额' })
  fireEvent.change(perNode, { target: { value: '9' } })
  expect(perNode.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById(perNode.getAttribute('aria-describedby')!)?.textContent).toContain('每台电脑配额不能超过总配额')
  expect(screen.getByRole('button', { name: '保存 Runtime 配额' })).toHaveProperty('disabled', true)
  expect(api.saveRuntimeAllocationPolicy).not.toHaveBeenCalled()
})

it('explains the first allocation while keeping its action outside the optional limits editor', async () => {
  vi.mocked(api.listUserRuntimes).mockResolvedValue({ items: [], nextCursor: null })
  render(<UserRuntimePanel userId={1} />)
  expect(await screen.findByText('尚未分配 Runtime')).toBeTruthy()
  expect(screen.getByRole('button', { name: '在当前电脑分配 Runtime' })).toHaveProperty('disabled', false)
  const disclosure = screen.getByText('Runtime 配额', { selector: 'summary' }).closest('details')!
  expect(disclosure.open).toBe(false)
  expect(disclosure.contains(screen.getByRole('button', { name: '在当前电脑分配 Runtime' }))).toBe(false)
})
