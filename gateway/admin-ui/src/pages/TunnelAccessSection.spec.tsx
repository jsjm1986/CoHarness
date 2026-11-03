/** Public-access tunnel section: binary install, quick-link start, named form, and stop lifecycle. */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
  vi.mocked(api.getTunnelAccess).mockReset()
  vi.mocked(api.installTunnelBinary).mockReset()
  vi.mocked(api.tunnelAccessAction).mockReset()
  vi.mocked(api.getTunnelAccess).mockResolvedValue(stopped)
  vi.mocked(api.installTunnelBinary).mockResolvedValue({ ...stopped, binary: stopped.binary })
  vi.mocked(api.tunnelAccessAction).mockResolvedValue(stopped)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function capturePoll() {
  let poll = () => {}
  const original = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, ...args) => {
    if (typeof handler === 'function' && args[0] === 10_000) poll = () => { handler() }
    return original(handler, ...args)
  })
  return () => poll()
}

describe('TunnelAccessSection', () => {
  it('publishes a slow initial read after multiple polling ticks without overlapping it', async () => {
    const poll = capturePoll()
    const initial = deferred<api.TunnelAccessView>()
    vi.mocked(api.getTunnelAccess).mockReturnValueOnce(initial.promise).mockResolvedValue(stopped)
    render(<TunnelAccessSection />)
    await screen.findByText('正在加载隧道状态')
    act(() => { poll(); poll() })
    expect(api.getTunnelAccess).toHaveBeenCalledTimes(1)
    await act(async () => { initial.resolve(stopped) })
    await screen.findByRole('button', { name: '开启临时链接' })
    await act(async () => { poll() })
    expect(api.getTunnelAccess).toHaveBeenCalledTimes(2)
  })

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

  it('shows the initial read failure with a retry action', async () => {
    vi.mocked(api.getTunnelAccess).mockRejectedValueOnce(new Error('read unavailable'))
    render(<TunnelAccessSection />)
    expect((await screen.findByRole('alert')).textContent).toContain('read unavailable')
    await userEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(await screen.findByRole('button', { name: '开启临时链接' })).toBeTruthy()
  })

  it('allows Stop during startup and ignores the cancelled start reply', async () => {
    const start = deferred<api.TunnelAccessView>()
    vi.mocked(api.tunnelAccessAction).mockImplementation(body => body.action === 'start-quick' ? start.promise : Promise.resolve(stopped))
    render(<TunnelAccessSection />)
    await userEvent.click(await screen.findByRole('button', { name: '开启临时链接' }))
    await userEvent.click(screen.getByRole('button', { name: '停止隧道' }))
    await screen.findByText('隧道已停止')
    await act(async () => { start.reject(new Error('tunnel-start-cancelled')) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('隧道已停止')).toBeTruthy()
    expect(api.tunnelAccessAction).toHaveBeenCalledWith({ action: 'stop' })
  })

  it('retains Stop when the server reports an unconfirmed cleanup', async () => {
    vi.mocked(api.getTunnelAccess).mockResolvedValue({ ...stopped, mode: 'quick', state: 'error', lastError: 'tunnel-stop-unconfirmed' })
    render(<TunnelAccessSection />)
    await userEvent.click(await screen.findByRole('button', { name: '停止隧道' }))
    expect(api.tunnelAccessAction).toHaveBeenCalledWith({ action: 'stop' })
  })

  it('does not let a pre-action poll overwrite the Stop reply', async () => {
    const poll = capturePoll()
    const old = deferred<api.TunnelAccessView>()
    const running: api.TunnelAccessView = { ...stopped, mode: 'quick', state: 'running', publicUrl: 'https://old.trycloudflare.com' }
    vi.mocked(api.getTunnelAccess).mockResolvedValueOnce(running).mockReturnValueOnce(old.promise)
    render(<TunnelAccessSection />)
    await screen.findByText(running.publicUrl!)
    act(() => { poll() })
    await userEvent.click(screen.getByRole('button', { name: '停止隧道' }))
    await screen.findByText('隧道已停止')
    await act(async () => { old.resolve(running) })
    expect(screen.queryByText(running.publicUrl!)).toBeNull()
    expect(screen.getByRole('button', { name: '开启临时链接' })).toBeTruthy()
  })

  it('keeps an action failure visible after a successful background read', async () => {
    const poll = capturePoll()
    vi.mocked(api.tunnelAccessAction).mockRejectedValue(new Error('start unavailable'))
    render(<TunnelAccessSection />)
    await userEvent.click(await screen.findByRole('button', { name: '开启临时链接' }))
    await screen.findByRole('alert')
    await act(async () => { poll() })
    expect(screen.getByRole('alert').textContent).toContain('start unavailable')
  })

  it('keeps intentionally cleared hostname and zone drafts empty', async () => {
    vi.mocked(api.getTunnelAccess).mockResolvedValue({ ...stopped, mode: 'named', hostname: 'team.example.com', domain: 'example.com' })
    render(<TunnelAccessSection />)
    const hostname = await screen.findByDisplayValue('team.example.com')
    await userEvent.clear(hostname)
    await userEvent.clear(screen.getByDisplayValue('example.com'))
    expect((hostname as HTMLInputElement).value).toBe('')
    expect((screen.getByPlaceholderText('默认取主机名末两段，如 example.com') as HTMLInputElement).value).toBe('')
  })

  it('reports clipboard refusal without announcing a successful copy', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('clipboard denied'))
    vi.mocked(api.getTunnelAccess).mockResolvedValue({ ...stopped, mode: 'quick', state: 'running', publicUrl: 'https://copy.trycloudflare.com' })
    render(<TunnelAccessSection />)
    await user.click(await screen.findByRole('button', { name: '复制链接' }))
    await waitFor(() => { expect(screen.queryByText('已复制')).toBeNull() })
    expect(screen.getByRole('alert').textContent).toContain('复制失败')
  })
})
