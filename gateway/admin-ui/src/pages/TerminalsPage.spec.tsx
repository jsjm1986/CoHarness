import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { TerminalsPage } from './TerminalsPage.tsx'

vi.mock('../api.ts', () => ({ listUsers: vi.fn(), listProjects: vi.fn(), getTerminalPolicy: vi.fn(), setTerminalPolicy: vi.fn(), listTerminals: vi.fn(), closeTerminal: vi.fn() }))
afterEach(cleanup)
const terminal: api.AdminTerminal = { ownerId: 'b0e81aa9-219c-44d6-8d42-af333c722db6', id: 'terminal-1', sessionId: 'session-1', creatorUserId: 1, state: 'running' }
const inventory: api.AdminTerminalInventory = { nodeId: 'node-a', generation: 3, target: { kind: 'user', id: 1 }, terminals: [terminal] }
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.listUsers).mockResolvedValue([{ id: 1, username: 'alice', displayName: 'Alice' } as api.AdminUser])
  vi.mocked(api.listProjects).mockResolvedValue([{ id: 7, name: 'Shared' } as api.Project])
  vi.mocked(api.getTerminalPolicy).mockImplementation(async (kind, id) => ({ kind, id, enabled: false, revision: '0' }))
  vi.mocked(api.listTerminals).mockResolvedValue(inventory)
  vi.mocked(api.closeTerminal).mockResolvedValue({ closed: true })
})
async function selectUser() {
  const user = userEvent.setup()
  await waitFor(() => expect(screen.getByLabelText('终端运行范围').querySelector('option[value="user:1"]')).toBeTruthy())
  await user.selectOptions(screen.getByLabelText('终端运行范围'), 'user:1')
  return user
}
it('confirms closing the reviewed node and generation, then reloads the inventory', async () => {
  render(<TerminalsPage />)
  const user = await selectUser()
  expect(await screen.findByText('terminal-1')).toBeTruthy()
  expect(screen.getByText('用户 #1')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  await user.click(screen.getByRole('button', { name: '关闭终端' }))
  expect(api.closeTerminal).not.toHaveBeenCalled()
  vi.mocked(api.listTerminals).mockResolvedValue({ ...inventory, terminals: [] })
  await user.click(screen.getByRole('button', { name: '确认关闭' }))
  expect(api.closeTerminal).toHaveBeenCalledWith(inventory, terminal)
  expect(await screen.findByText('没有保留的终端。')).toBeTruthy()
  expect(screen.getByText('进程已完成清理。')).toBeTruthy()
})
it('keeps cleanup failures visible and reloads a stopping entry before retry', async () => {
  vi.mocked(api.closeTerminal).mockRejectedValueOnce(new Error('runtime unavailable'))
  render(<TerminalsPage />)
  const user = await selectUser()
  await user.click(await screen.findByRole('button', { name: '关闭终端' }))
  await user.click(screen.getByRole('button', { name: '确认关闭' }))
  expect(await screen.findByText(/尚未确认清理完成/)).toBeTruthy()
  expect(screen.queryByText('进程已完成清理。')).toBeNull()
  vi.mocked(api.listTerminals).mockResolvedValue({ ...inventory, terminals: [{ ...terminal, state: 'stopping' }] })
  await user.click(screen.getByRole('button', { name: '刷新终端清单' }))
  await user.click(await screen.findByRole('button', { name: '重试清理' }))
  await user.click(screen.getByRole('button', { name: '确认关闭' }))
  expect(api.closeTerminal).toHaveBeenCalledTimes(2)
})
it('cancels old scope reads and ignores their late inventory', async () => {
  let finish!: (value: api.AdminTerminalInventory) => void
  const old = new Promise<api.AdminTerminalInventory>(resolve => { finish = resolve })
  vi.mocked(api.listTerminals).mockImplementation((kind, id) => kind === 'user' ? old : Promise.resolve({ nodeId: 'node-a', target: { kind, id }, generation: null, terminals: [] }))
  render(<TerminalsPage />)
  const user = await selectUser()
  const signal = vi.mocked(api.listTerminals).mock.calls[0]![2]!
  await user.selectOptions(screen.getByLabelText('终端运行范围'), 'project:7')
  expect(signal.aborted).toBe(true)
  expect(await screen.findByText(/实例未运行/)).toBeTruthy()
  await act(async () => { finish(inventory); await old })
  expect(screen.queryByText('terminal-1')).toBeNull()
  expect(screen.queryByRole('button', { name: '关闭终端' })).toBeNull()
})
it('rejects an inventory for a different target and permits retry', async () => {
  vi.mocked(api.listTerminals).mockResolvedValueOnce({ ...inventory, target: { kind: 'project', id: 7 } })
  render(<TerminalsPage />)
  const user = await selectUser()
  expect(await screen.findByText(/终端清单与选中范围不一致/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '关闭终端' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '刷新终端清单' }))
  expect(await screen.findByText('terminal-1')).toBeTruthy()
})
it('disables target changes during cleanup and cancels reads on unmount', async () => {
  let finish!: (value: { closed: true }) => void
  const closing = new Promise<{ closed: true }>(resolve => { finish = resolve })
  vi.mocked(api.closeTerminal).mockReturnValue(closing)
  const view = render(<TerminalsPage />)
  const user = await selectUser()
  await user.click(await screen.findByRole('button', { name: '关闭终端' }))
  await user.click(screen.getByRole('button', { name: '确认关闭' }))
  expect(screen.getByLabelText('终端运行范围')).toHaveProperty('disabled', true)
  view.unmount()
  expect(vi.mocked(api.listTerminals).mock.calls[0]![2]!.aborted).toBe(true)
  await act(async () => { finish({ closed: true }); await closing })
  expect(api.listTerminals).toHaveBeenCalledTimes(1)
})
