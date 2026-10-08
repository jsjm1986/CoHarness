/** A failed taskkill cannot establish descendant exit from the parent's exit alone. */
import type { ChildProcess } from 'node:child_process'
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
  vi.clearAllMocks()
})

async function abortWindowsCommand(status: number, reason: Error): Promise<void> {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: 0,
    signalCode: null,
    stdout,
    stderr,
    kill: vi.fn(),
  }) as ChildProcess
  childProcesses.spawn.mockReturnValue(child)
  childProcesses.spawnSync.mockReturnValue({ status })
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  try {
    const controller = new AbortController()
    const running = runCommandWithTimeout('resolver.exe', [], {
      cwd: '.',
      env: {},
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    controller.abort(reason)
    child.emit('close', 0, null)
    await running
  } finally {
    stdout.destroy()
    stderr.destroy()
    vi.unstubAllGlobals()
  }
}

it('rejects failed Windows process-tree termination after the parent exits', async () => {
  await expect(abortWindowsCommand(1, new Error('caller cancelled')))
    .rejects.toThrow('taskkill failed to terminate process tree 123 (status 1)')
  expect(childProcesses.spawnSync).toHaveBeenCalledOnce()
  expect(childProcesses.spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '123', '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000,
  })
})

it('preserves the caller reason after confirmed Windows process-tree termination', async () => {
  const reason = new Error('caller cancelled')
  await expect(abortWindowsCommand(0, reason)).rejects.toBe(reason)
})
