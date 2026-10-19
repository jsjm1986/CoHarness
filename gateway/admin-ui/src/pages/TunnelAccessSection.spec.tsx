/** Public-access tunnel section: binary install, quick-link start, named form, and stop lifecycle. */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { TunnelAccessSection } from './TunnelAccessSection.tsx'

vi.mock('../api.ts', () => ({
  getTunnelAccess: vi.fn(),
  installTunnelBinary: vi.fn(),
  tunnelAccessAction: vi.fn(),
}))

const stopped: api.TunnelAccessView = {
  supported: true,
  binary: { path: '/state/tunnel/bin/cloudflared', version: '2026.9.3', source: 'state-dir' },
  mode: 'off', desired: 'stopped', state: 'stopped',
  publicUrl: null, hostname: null, domain: null, apiTokenConfigured: false,
  lastError: null, revision: 1, startedAt: null, updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.mocked(api.getTunnelAccess).mockResolvedValue(stopped)
  vi.mocked(api.installTunnelBinary).mockResolvedValue({ ...stopped, binary: stopped.binary })
  vi.mocked(api.tunnelAccessAction).mockResolvedValue(stopped)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('TunnelAccessSection', () => {
  it('offers install when the binary is missing', async () => {
    vi.mocked(api.getTunnelAccess).mockResolvedValue({ ...stopped, binary: null })
    render(<TunnelAccessSection />)
    const button = await screen.findByRole('button', { name: /cloudflared/i })
    await userEvent.click(button)
    expect(api.installTunnelBinary).toHaveBeenCalled()
  })

  it('starts a quick link from the choices grid', async () => {
    render(<TunnelAccessSection />)
    await screen.findByText('开启临时链接')
    await userEvent.click(screen.getByRole('button', { name: '开启临时链接' }))
    expect(api.tunnelAccessAction).toHaveBeenCalledWith({ action: 'start-quick' })
  })

  it('disables the named start until a hostname is entered', async () => {
    render(<TunnelAccessSection />)
    const start = await screen.findByRole('button', { name: '开启固定域名' })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(screen.getByPlaceholderText('例如 team.example.com'), 'team.example.com')
    await userEvent.type(screen.getByPlaceholderText(/仅首次配置需要/), 'CF-TOKEN')
    await userEvent.click(start)
    expect(api.tunnelAccessAction).toHaveBeenCalledWith({
      action: 'start-named', hostname: 'team.example.com', apiToken: 'CF-TOKEN',
    })
  })

  it('shows the public URL and stop action while running', async () => {
    vi.mocked(api.getTunnelAccess).mockResolvedValue({
      ...stopped, mode: 'quick', desired: 'running', state: 'running',
      publicUrl: 'https://a-b-c.trycloudflare.com',
    })
    render(<TunnelAccessSection />)
    expect(await screen.findByText('https://a-b-c.trycloudflare.com')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '停止隧道' }))
    expect(api.tunnelAccessAction).toHaveBeenCalledWith({ action: 'stop' })
  })
})
