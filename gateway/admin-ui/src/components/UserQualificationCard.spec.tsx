import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { UserQualificationCard } from './UserQualificationCard.tsx'

vi.mock('../api.ts', () => ({ getSshPolicy: vi.fn(), setSshPolicy: vi.fn() }))
afterEach(cleanup)

describe('UserQualificationCard', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getSshPolicy).mockResolvedValue({ kind: 'user', id: 1, enabled: false, revision: '0' })
    vi.mocked(api.setSshPolicy).mockResolvedValue({ kind: 'user', id: 1, enabled: true, revision: '1' })
  })

  it('loads the fixed user policy and saves it with its revision', async () => {
    const user = userEvent.setup()
    render(<UserQualificationCard name="SSH" description="远程资格。" userId={1} read={api.getSshPolicy} write={api.setSshPolicy} />)
    expect(api.getSshPolicy).toHaveBeenCalledWith('user', 1, expect.any(AbortSignal))
    const checkbox = await screen.findByRole('checkbox', { name: '授予此用户SSH资格' })
    expect((checkbox as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText(/来源：默认拒绝/)).toBeTruthy()
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: '保存SSH授权' }))
    expect(api.setSshPolicy).toHaveBeenCalledWith({ kind: 'user', id: 1, enabled: true, revision: '0' })
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '已授予资格。')
    expect(screen.getByText(/版本 1/)).toBeTruthy()
  })

  it('rejects a stale save and reloads the current authorization', async () => {
    const user = userEvent.setup()
    render(<UserQualificationCard name="SSH" description="远程资格。" userId={1} read={api.getSshPolicy} write={api.setSshPolicy} />)
    await user.click(await screen.findByRole('checkbox'))
    vi.mocked(api.setSshPolicy).mockRejectedValue(new Error('policy changed'))
    await user.click(screen.getByRole('button', { name: '保存SSH授权' }))
    expect(await screen.findByText(/请重新读取当前授权/)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    vi.mocked(api.getSshPolicy).mockResolvedValue({ kind: 'user', id: 1, enabled: true, revision: '2' })
    await user.click(screen.getByRole('button', { name: '重新读取授权' }))
    expect((await screen.findByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/版本 2/)).toBeTruthy()
  })

  it('shows a reload action when the initial read fails', async () => {
    vi.mocked(api.getSshPolicy).mockRejectedValueOnce(new Error('network unavailable'))
    const user = userEvent.setup()
    render(<UserQualificationCard name="SSH" description="远程资格。" userId={1} read={api.getSshPolicy} write={api.setSshPolicy} />)
    expect(await screen.findByText('network unavailable')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '重新读取授权' }))
    expect(await screen.findByRole('checkbox', { name: '授予此用户SSH资格' })).toBeTruthy()
    expect(screen.queryByText('network unavailable')).toBeNull()
  })
})
