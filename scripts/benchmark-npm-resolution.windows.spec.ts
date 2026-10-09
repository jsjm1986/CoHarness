/** A failed taskkill cannot establish descendant exit from the parent's exit alone. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { runCommandWithTimeout } from './benchmark-npm-resolution.ts'

const childProcesses = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  ...childProcesses,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function fakeChild(pid: number, exitCode: number | null): EventEmitter & { stdout: PassThrough; stderr: PassThrough } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  return Object.assign(new EventEmitter(), {
    pid, exitCode, signalCode: null, stdout, stderr, kill: vi.fn(),
  })
}

async function abortWindowsCommand(status: number, reason: Error): Promise<void> {
  const child = fakeChild(123, 0)
  childProcesses.spawn.mockReturnValue(child)
  childProcesses.spawnSync.mockReturnValue({ status })
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  try {
    const controller = new AbortController()
    const running = runCommandWithTimeout('resolver.exe', [], {
      cwd: '.', env: {}, timeoutMs: 60_000, signal: controller.signal,
    })
    controller.abort(reason)
    child.emit('close', 0, null)
    await running
  } finally {
    child.stdout.destroy()
    child.stderr.destroy()
    vi.unstubAllGlobals()
  }
}

it('rejects failed Windows process-tree termination after the parent exits', async () => {
  await expect(abortWindowsCommand(1, new Error('caller cancelled')))
    .rejects.toThrow('taskkill failed to terminate process tree 123 (status 1)')
  expect(childProcesses.spawnSync).toHaveBeenCalledOnce()
  expect(childProcesses.spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '123', '/T', '/F'], {
    stdio: 'ignore', windowsHide: true, timeout: 5_000,
  })
})

it('preserves the caller reason after confirmed Windows process-tree termination', async () => {
  const reason = new Error('caller cancelled')
  await expect(abortWindowsCommand(0, reason)).rejects.toBe(reason)
})

it.skipIf(process.platform === 'win32')('reports a timed-out POSIX tree as settled when signalling is denied', async () => {
  const child = fakeChild(456, null)
  childProcesses.spawn.mockReturnValue(child)
  const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  const realKill = process.kill.bind(process)
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | string): true => {
    if (pid === -456) throw denied
    return realKill(pid, signal)
  })
  try {
    const reason = new Error('caller cancelled under denied signalling')
    const controller = new AbortController()
    const running = runCommandWithTimeout('resolver', [], {
      cwd: '.', env: {}, timeoutMs: 60_000, terminationGraceMs: 30,
      signal: controller.signal,
    })
    await vi.waitFor(() => { expect(killSpy).not.toHaveBeenCalled() })
    controller.abort(reason)
    await vi.waitFor(() => { expect(killSpy).toHaveBeenCalledWith(-456, 'SIGTERM') })
    child.emit('close', 0, null)
    // The denied TERM is skipped and the denied liveness probe reports the
    // group unobservable, so settlement is decided by the owned close event
    // and the abort path still surfaces the caller's exact reason.
    await expect(running).rejects.toBe(reason)
    expect(killSpy).toHaveBeenCalledWith(-456, 0)
  } finally {
    killSpy.mockRestore()
    child.stdout.destroy()
    child.stderr.destroy()
  }
})
