import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { DesktopPermissions } from './DesktopPermissions.tsx'
import { TerminalPermissions } from './TerminalPermissions.tsx'

vi.mock('../api.ts', () => ({ listUsers: vi.fn(), listProjects: vi.fn(), getDesktopPolicy: vi.fn(), setDesktopPolicy: vi.fn(), getTerminalPolicy: vi.fn(), setTerminalPolicy: vi.fn() }))
afterEach(cleanup)
describe.each([
  { name: '桌面', Component: DesktopPermissions, read: 'getDesktopPolicy', write: 'setDesktopPolicy', saved: '桌面授权已保存；用户仍需确认会话与桌面。' },
  { name: '终端', Component: TerminalPermissions, read: 'getTerminalPolicy', write: 'setTerminalPolicy', saved: '终端授权已保存；项目空间仍需同时具备用户资格、项目授权和可写成员身份。' },
] as const)('$name permissions', ({ name, Component, read, write, saved }) => {
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 7, name: 'Shared' } as api.Project,
    { id: 8, name: 'Second' } as api.Project,
  ])
  vi.mocked(api[read]).mockImplementation(async (kind, id) => ({ kind, id, enabled: false, revision: '0' }))
})

it('offers only project subjects and saves project authorization with its revision', async () => {
  const user = userEvent.setup()
  render(<Component />)
  const picker = await screen.findByLabelText(`${name}授权对象`)
  expect(screen.queryByRole('option', { name: /用户 ·/ })).toBeNull()
  expect(api.listUsers).not.toHaveBeenCalled()
  await user.selectOptions(picker, 'project:7')
  const checkbox = await screen.findByRole('checkbox', { name: `允许此项目使用${name}` })
  expect((checkbox as HTMLInputElement).checked).toBe(false)
  expect(screen.getByText(/来源：默认拒绝/)).toBeTruthy()
  vi.mocked(api[write]).mockResolvedValue({ kind: 'project', id: 7, enabled: true, revision: '1' })
  await user.click(checkbox)
  await user.click(screen.getByRole('button', { name: `保存${name}授权` }))
  expect(api[write]).toHaveBeenCalledWith({ kind: 'project', id: 7, enabled: true, revision: '0' })
  expect(await screen.findByRole('status')).toHaveProperty('textContent', saved)
})

it('rejects stale saves and requires a fresh read before retrying', async () => {
  const user = userEvent.setup()
  render(<Component />)
  await user.selectOptions(await screen.findByLabelText(`${name}授权对象`), 'project:7')
  await user.click(await screen.findByRole('checkbox'))
  vi.mocked(api[write]).mockRejectedValue(new Error('policy changed'))
  await user.click(screen.getByRole('button', { name: `保存${name}授权` }))
  expect(await screen.findByText(/请重新读取当前授权/)).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  vi.mocked(api[read]).mockResolvedValue({ kind: 'project', id: 7, enabled: true, revision: '2' })
  await user.click(screen.getByRole('button', { name: '重新读取授权' }))
  expect((await screen.findByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText(/版本 2/)).toBeTruthy()
})

it('ignores a late response for another owner and cancels its read', async () => {
  let finish!: (value: api.AdminResourcePolicy) => void
  const oldRead = new Promise<api.AdminResourcePolicy>(resolve => { finish = resolve })
  vi.mocked(api[read]).mockImplementation((kind, id) => id === 7 ? oldRead : Promise.resolve({ kind, id, enabled: false, revision: '3' }))
  const user = userEvent.setup()
  render(<Component />)
  await user.selectOptions(await screen.findByLabelText(`${name}授权对象`), 'project:7')
  await waitFor(() => expect(api[read]).toHaveBeenCalledTimes(1))
  const oldSignal = vi.mocked(api[read]).mock.calls[0]![2]!
  await user.selectOptions(screen.getByLabelText(`${name}授权对象`), 'project:8')
  expect(oldSignal.aborted).toBe(true)
  await screen.findByRole('checkbox', { name: `允许此项目使用${name}` })
  await act(async () => { finish({ kind: 'project', id: 7, enabled: true, revision: '99' }); await oldRead })
  expect(screen.getByText(/版本 3/)).toBeTruthy()
})


it('lets an administrator retry loading owners after a network failure', async () => {
  vi.mocked(api.listProjects).mockRejectedValueOnce(new Error('network unavailable'))
  const user = userEvent.setup()
  render(<Component />)
  expect(await screen.findByText('network unavailable')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '重新加载授权对象' }))
  await waitFor(() => expect(screen.getByRole('option', { name: /Shared/ })).toBeTruthy())
  expect(screen.queryByText('network unavailable')).toBeNull()
})

})
