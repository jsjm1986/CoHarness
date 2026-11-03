/** Exact Runtime choices remain explicit when a computer hosts multiple personal allocations. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { RuntimePicker } from './RuntimePicker.tsx'
import { runtimeFixture } from './runtime-fixture.ts'

vi.mock('../api.ts', () => ({ getAdminComputerContext: vi.fn(), listRuntimeEnvironments: vi.fn(), listUserRuntimes: vi.fn() }))
let deploymentRevision: string | undefined
vi.mock('../deployment-context.tsx', () => ({ useDeploymentContext: () => ({ value: deploymentRevision === undefined ? null : {
  mode: 'single', revision: deploymentRevision, scope: 'local', role: 'standalone',
  entry: { nodeId: 'node-a', name: 'Computer A' }, primary: null, refreshAfterMs: 30000, legacyMigrationRequired: false,
} }) }))
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  deploymentRevision = undefined
  vi.mocked(api.getAdminComputerContext).mockResolvedValue({ nodeId: 'node-a' as api.RuntimeNodeId, name: 'Computer A', forwardingEnabled: true })
})

it('revalidates the retained Runtime after a policy revision without choosing another assignment', async () => {
  const runtime = runtimeFixture('user', 1)
  vi.mocked(api.listUserRuntimes).mockResolvedValueOnce({ items: [runtime], nextCursor: null })
    .mockResolvedValueOnce({ items: [], nextCursor: null })
  const selected = vi.fn(), availability = vi.fn()
  const view = render(<RuntimePicker owner={{ kind: 'user', id: 1 }} value={runtime} onSelect={selected} onAvailabilityChange={availability} />)
  await waitFor(() => expect(availability).toHaveBeenLastCalledWith(true))
  deploymentRevision = '2'
  view.rerender(<RuntimePicker owner={{ kind: 'user', id: 1 }} value={runtime} onSelect={selected} onAvailabilityChange={availability} />)
  await waitFor(() => expect(api.listUserRuntimes).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(availability).toHaveBeenLastCalledWith(false))
  expect(screen.getByLabelText('选择 Runtime')).toHaveProperty('value', runtime.id)
  expect(selected).not.toHaveBeenCalled()
})

it('requires an explicit choice between the same account’s Runtimes and excludes another computer', async () => {
  const first = runtimeFixture('user', 1)
  const second = { ...runtimeFixture('user', 2), owner: first.owner }
  const otherComputer = { ...runtimeFixture('user', 3), owner: first.owner, node: { ...first.node, id: 'node-b' as api.RuntimeNodeId, name: 'Computer B' } }
  vi.mocked(api.listUserRuntimes).mockResolvedValue({ items: [first, second, otherComputer], nextCursor: null })
  const selected = vi.fn()
  render(<RuntimePicker owner={{ kind: 'user', id: 1 }} onSelect={selected} />)
  const picker = screen.getByLabelText('选择 Runtime')
  await waitFor(() => expect(picker.querySelectorAll('option')).toHaveLength(3))
  expect(selected).not.toHaveBeenCalled()
  expect(picker.querySelector(`option[value="${otherComputer.id}"]`)).toBeNull()
  await userEvent.selectOptions(picker, second.id)
  expect(selected).toHaveBeenLastCalledWith(second)
})

it('does not choose the only visible Runtime while more assignments remain unread', async () => {
  vi.mocked(api.listUserRuntimes).mockResolvedValue({ items: [runtimeFixture('user', 1)], nextCursor: 'next-page' as NonNullable<api.RuntimeCatalogPage['nextCursor']> })
  const selected = vi.fn()
  render(<RuntimePicker owner={{ kind: 'user', id: 1 }} onSelect={selected} />)
  expect(await screen.findByRole('button', { name: '更多 Runtime' })).toBeTruthy()
  expect(selected).not.toHaveBeenCalled()
})

it('retains the captured selection and withdraws operation availability when refreshing is refused', async () => {
  const runtime = runtimeFixture('user', 1)
  vi.mocked(api.listUserRuntimes).mockResolvedValueOnce({ items: [runtime], nextCursor: null }).mockRejectedValueOnce(new Error('computer access revoked'))
  const selected = vi.fn(), availability = vi.fn()
  render(<RuntimePicker owner={{ kind: 'user', id: 1 }} value={runtime} onSelect={selected} onAvailabilityChange={availability} />)
  await waitFor(() => expect(availability).toHaveBeenLastCalledWith(true))
  await userEvent.click(screen.getByRole('button', { name: '刷新 Runtime' }))
  expect(await screen.findByText('computer access revoked')).toBeTruthy()
  expect(availability).toHaveBeenLastCalledWith(false)
  expect(selected).not.toHaveBeenCalled()
})

it('retains an unavailable Runtime without substituting another assignment', async () => {
  const runtime = runtimeFixture('user', 1)
  vi.mocked(api.listUserRuntimes).mockResolvedValueOnce({ items: [runtime], nextCursor: null }).mockResolvedValueOnce({ items: [], nextCursor: null })
  const selected = vi.fn(), availability = vi.fn()
  render(<RuntimePicker owner={{ kind: 'user', id: 1 }} value={runtime} onSelect={selected} onAvailabilityChange={availability} />)
  await waitFor(() => expect(availability).toHaveBeenLastCalledWith(true))
  await userEvent.click(screen.getByRole('button', { name: '刷新 Runtime' }))
  await screen.findByText('所选 Runtime 已不可用，目标和未保存内容仍保留，请刷新后核对')
  expect(availability).toHaveBeenLastCalledWith(false)
  expect(selected).not.toHaveBeenCalled()
})
