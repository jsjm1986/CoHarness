import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { DesktopsPage } from './DesktopsPage.tsx'

vi.mock('../api.ts', () => ({
  applyDesktopAction: vi.fn(),
  getDesktopDetail: vi.fn(),
  getDesktopPolicy: vi.fn(),
  listDesktops: vi.fn(),
  listProjects: vi.fn(),
  listUsers: vi.fn(),
  setDesktopPolicy: vi.fn(),
}))

const resource = (state: 'available' | 'unavailable', desktop: string): api.AdminDesktopResource => ({
  resourceKey: `node-1/${desktop}`,
  node: 'node-1',
  desktop,
  fencingSeq: 3,
  queueSeq: 0,
  state,
  stateNote: state === 'available' ? null : 'holder heartbeat lost',
  updatedAt: Date.UTC(2026, 8, 25),
})

const detail = (state: 'available' | 'unavailable', desktop: string): api.AdminDesktopDetail => ({
  resource: resource(state, desktop),
  grants: [],
  queue: [],
})

describe('DesktopsPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listDesktops).mockResolvedValue({ resources: [resource('available', 'held')] })
    vi.mocked(api.getDesktopDetail).mockResolvedValue(detail('available', 'held'))
    vi.mocked(api.applyDesktopAction).mockResolvedValue({ ok: true } as never)
    vi.mocked(api.listUsers).mockResolvedValue([])
    vi.mocked(api.listProjects).mockResolvedValue([])
  })

  it('enables clear only while the selected resource is unavailable', async () => {
    render(<DesktopsPage />)
    await userEvent.click((await screen.findAllByRole('button', { name: '详情' }))[0]!)
    const disabledClear = await screen.findByRole('button', { name: '清理不可用状态' })
    expect((disabledClear as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(disabledClear)
    expect(screen.queryByRole('dialog')).toBeNull()

    vi.mocked(api.getDesktopDetail).mockResolvedValue(detail('unavailable', 'held'))
    await userEvent.click(screen.getAllByRole('button', { name: '详情' })[0]!)
    const enabledClear = await screen.findByRole('button', { name: '清理不可用状态' })
    expect((enabledClear as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(enabledClear)
    const confirm = screen.getByRole('dialog', { name: '清理不可用桌面' })
    await userEvent.click(within(confirm).getByRole('button', { name: '清理' }))
    await waitFor(() => expect(api.applyDesktopAction).toHaveBeenCalledWith('clear', { node: 'node-1', desktop: 'held' }))
  })
})
