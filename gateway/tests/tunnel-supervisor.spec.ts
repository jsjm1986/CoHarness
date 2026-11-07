/** Tunnel output, allocation failure and termination stay owned until child closure. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnNamedTunnel as allocateNamed, spawnQuickTunnel as allocateQuick, type TunnelLaunchOptions, type TunnelProc } from '../src/tunnel-supervisor.ts'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: spawnMock,
}))

const children: ReturnType<typeof childFixture>[] = []
const timing = { startupTimeoutMs: 30000, closeTimeoutMs: 1000, probeIntervalMs: 25 }
const handles: TunnelProc[] = []
beforeEach(() => { vi.spyOn(process, 'kill').mockReturnValue(true) })
function spawnNamedTunnel(bin: string, token: string, options: TunnelLaunchOptions = timing) {
  const handle = allocateNamed(bin, token, options); handles.push(handle); return handle
}
function spawnQuickTunnel(bin: string, target: string, options: TunnelLaunchOptions = timing) {
  const handle = allocateQuick(bin, target, options); handles.push(handle); return handle
}
function registrationFile(index = 0): string {
  const args = spawnMock.mock.calls[index]?.[1] as string[]
  return args[args.indexOf('--pidfile') + 1]!
}
function register(child: ReturnType<typeof childFixture>, index = 0) {
  child.pid = 1234567 + index
  writeFileSync(registrationFile(index), String(child.pid))
}
function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined, exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  })
  spawnMock.mockReturnValueOnce(child)
  return child
}
function allocate() { const child = childFixture(); children.push(child); return child }
afterEach(async () => {
  for (const child of children.splice(0)) { child.emit('close', 0, null); child.stdout.destroy(); child.stderr.destroy() }
  await Promise.all(handles.splice(0).map(handle => handle.terminate(0)))
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); spawnMock.mockReset()
})

describe('tunnel process ownership', () => {
  it('requires the owned registration witness even when a named child remains alive', async () => {
    vi.useFakeTimers()
    const child = allocate(), proc = spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token')
    let ready = false
    void proc.ready.then(() => { ready = true })
    await vi.advanceTimersByTimeAsync(3001)
    expect(ready).toBe(false)
    child.pid = 1234567
    writeFileSync(registrationFile(), '7654321')
    await vi.advanceTimersByTimeAsync(25)
    expect(ready).toBe(false)
    register(child)
    await vi.advanceTimersByTimeAsync(25); await proc.ready
    expect(ready).toBe(true)
  })

  it('does not treat the quick URL alone as a registered connection', async () => {
    vi.useFakeTimers()
    const child = allocate(), proc = spawnQuickTunnel('/fixture/cloudflared', 'http://127.0.0.1:1')
    child.stdout.write('https://fixture.trycloudflare.com\n')
    let ready = false
    void proc.ready.then(() => { ready = true })
    await vi.advanceTimersByTimeAsync(3001)
    expect(ready).toBe(false)
    register(child)
    await vi.advanceTimersByTimeAsync(25); await proc.ready
    expect(ready).toBe(true)
  })

  it('bounds startup and failed closure, retains its owner, then confirms a later close', async () => {
    vi.useFakeTimers()
    const child = allocate(), proc = spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token', {
      startupTimeoutMs: 17, closeTimeoutMs: 19, probeIntervalMs: 5,
    })
    const failure = expect(proc.ready).rejects.toMatchObject({ code: 'startup-timeout' })
    await vi.advanceTimersByTimeAsync(17); await failure
    expect(existsSync(dirname(registrationFile()))).toBe(true)
    const stopping = expect(proc.terminate(0)).rejects.toMatchObject({ code: 'stop-unconfirmed' })
    await vi.advanceTimersByTimeAsync(20); await stopping
    expect(proc.hasExited()).toBe(false)
    expect(existsSync(dirname(registrationFile()))).toBe(true)
    child.emit('close', 0, null)
    await proc.terminate(0); await proc.exited
    expect(existsSync(dirname(registrationFile()))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes startup polling on caller cancellation and releases parent-exit observation after closure', async () => {
    vi.useFakeTimers()
    const before = process.listenerCount('exit'), caller = new AbortController(), child = allocate()
    const proc = spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token', { ...timing, signal: caller.signal })
    const failure = expect(proc.ready).rejects.toThrow('caller closed')
    caller.abort(new Error('caller closed')); await failure
    expect(vi.getTimerCount()).toBe(0)
    child.emit('close', 0, null); await proc.exited
    expect(process.listenerCount('exit')).toBe(before)
  })

  it('does not signal an exited leader while inherited stdio is still open', async () => {
    vi.useFakeTimers()
    const child = allocate(), proc = spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token', {
      ...timing, closeTimeoutMs: 19,
    })
    register(child); await vi.advanceTimersByTimeAsync(25); await proc.ready
    child.exitCode = 0
    const stopped = expect(proc.terminate(0)).rejects.toMatchObject({ code: 'stop-unconfirmed' })
    await vi.advanceTimersByTimeAsync(20); await stopped
    expect(process.kill).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled()
    expect(proc.hasExited()).toBe(false)
    child.emit('close', 0, null); await proc.terminate(0); await proc.exited
  })

  it('refuses allocation when its caller was already cancelled', () => {
    const caller = new AbortController(), reason = new Error('caller already closed')
    caller.abort(reason)
    expect(() => spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token', { ...timing, signal: caller.signal })).toThrow(reason)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized registration file without accepting its supplied PID', async () => {
    vi.useFakeTimers()
    allocate(); const proc = spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token')
    writeFileSync(registrationFile(), '1'.repeat(65536))
    const failure = expect(proc.ready).rejects.toMatchObject({ code: 'start-failed' })
    await vi.advanceTimersByTimeAsync(25); await failure
  })

  it('drains both named-tunnel streams without retaining output', async () => {
    const child = allocate(), proc = spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token')
    await Promise.all([child.stdout, child.stderr].map(stream => new Promise<void>(resolve => stream.write(Buffer.alloc(2 ** 20), () => resolve()))))
    child.emit('close', 0, null)
    await expect(proc.exited).resolves.toEqual({ code: 0, signal: null })
    expect(proc.hasExited()).toBe(true)
  })

  it('finds split quick URLs in one stream and detaches scanning after readiness', async () => {
    const child = allocate(), proc = spawnQuickTunnel('/fixture/cloudflared', 'http://127.0.0.1:1')
    child.stdout.write(Buffer.alloc(2 ** 20, 120))
    child.stderr.write('unrelated diagnostic\n')
    child.stdout.write('https://fixture.trycloud')
    child.stdout.write('flare.com\n')
    register(child)
    await proc.ready
    expect(proc.publicUrl).toBe('https://fixture.trycloudflare.com')
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    await Promise.all([child.stdout, child.stderr].map(stream => new Promise<void>(resolve => stream.write(Buffer.alloc(2 ** 20), () => resolve()))))
    child.emit('close', 0, null); await proc.exited
  })

  it('reports failed quick allocation before its URL deadline and awaits closure', async () => {
    const child = allocate(), proc = spawnQuickTunnel('/fixture/absent', 'http://127.0.0.1:1')
    const failure = expect(proc.ready).rejects.toMatchObject({ code: 'start-failed', message: 'cloudflared could not start' })
    child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))
    child.emit('close', -2, null)
    await failure
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  it('observes named allocation failure through close even without an exit event', async () => {
    const child = allocate(), proc = spawnNamedTunnel('/fixture/absent', 'synthetic-token')
    child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))
    expect(proc.hasExited()).toBe(false)
    child.emit('close', -2, null)
    await expect(proc.exited).resolves.toEqual({ code: -2, signal: null })
    expect(proc.hasExited()).toBe(true)
    await proc.terminate(0)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('forces termination at the caller supplied grace and waits for closure', async () => {
    vi.useFakeTimers()
    const child = allocate(); child.pid = 1234567
    const signals: Array<string | number | undefined> = []
    const signalChild = (signal: string | number | undefined): true => {
      signals.push(signal)
      if (signal === 'SIGKILL') { child.signalCode = 'SIGKILL'; child.emit('close', null, 'SIGKILL') }
      return true
    }
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => signalChild(signal))
    child.kill.mockImplementation(signalChild)
    const proc = spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token'), stopped = proc.terminate(17)
    expect(signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(16)
    expect(signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1); await stopped
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(proc.hasExited()).toBe(true)
  })

  it('excludes Gateway deployment and credential values from tunnel inheritance', () => {
    for (const name of ['HGW_DATABASE_URL', 'HGW_USERS_ROOT', 'DATABASE_URL', 'CLOUD_CREDENTIALS', 'PGPASSFILE']) vi.stubEnv(name, 'synthetic')
    allocate(); spawnNamedTunnel('/fixture/cloudflared', 'synthetic-token')
    const env = spawnMock.mock.calls[0]?.[2].env as NodeJS.ProcessEnv
    for (const name of ['HGW_DATABASE_URL', 'HGW_USERS_ROOT', 'DATABASE_URL', 'CLOUD_CREDENTIALS', 'PGPASSFILE']) expect(env[name]).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('supplies only the selected connector token through environment rather than process arguments', () => {
    vi.stubEnv('TUNNEL_TOKEN', 'unrelated-parent-token')
    allocate(); spawnNamedTunnel('/fixture/cloudflared', 'synthetic-run-token')
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['tunnel', '--no-autoupdate', '--pidfile', expect.any(String), 'run'])
    expect(spawnMock.mock.calls[0]?.[2].env.TUNNEL_TOKEN).toBe('synthetic-run-token')
  })
})
