/** Native process helpers use the owning command's cleanup budget. */
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createProcessInspector } from '../src/process-inspector.ts'
import { createWindowsProcessInspector } from '../src/windows-inspector.ts'
import { spawnSubprocess, taskkillProcessTree } from '../src/spawn.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(), spawnSync: vi.fn() }
})

describe('native process control deadlines', () => {
  it('bounds macOS table and foreground queries with an uncatchable timeout signal', () => {
    const execute = vi.mocked(execFileSync)
    execute.mockReturnValueOnce('77 1 start\n').mockReturnValueOnce('77')
    const inspector = createProcessInspector(37, 'darwin', 'arm64')
    expect(inspector.snapshot().tree(77)).toEqual([{ pid: 77, started: 'start' }])
    expect(inspector.foregroundPgid(77)).toBe(77)
    expect(execute).toHaveBeenNthCalledWith(1, '/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
      encoding: 'utf8', timeout: 37, killSignal: 'SIGKILL',
    })
    expect(execute).toHaveBeenNthCalledWith(2, '/bin/ps', ['-o', 'tpgid=', '-p', '77'], {
      encoding: 'utf8', timeout: 37, killSignal: 'SIGKILL',
    })
  })

  it('bounds ordinary Windows fallback signalling', () => {
    taskkillProcessTree(77, 41)
    expect(spawnSync).toHaveBeenLastCalledWith('taskkill', ['/PID', '77', '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 41, killSignal: 'SIGKILL',
    })
  })

  it('bounds both Windows terminal termination tiers', () => {
    const inspector = createWindowsProcessInspector(43)
    inspector.signalGroup(77, 'SIGTERM')
    expect(spawnSync).toHaveBeenLastCalledWith('taskkill', ['/PID', '77', '/T'], {
      stdio: 'ignore', windowsHide: true, timeout: 43, killSignal: 'SIGKILL',
    })
    inspector.signalGroup(77, 'SIGKILL')
    expect(spawnSync).toHaveBeenLastCalledWith('taskkill', ['/PID', '77', '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 43, killSignal: 'SIGKILL',
    })
  })

  it('rounds positive fractional grace up to a supported native timeout', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('')
    createProcessInspector(0.5, 'darwin').snapshot().tree(77)
    expect(execFileSync).toHaveBeenLastCalledWith('/bin/ps', expect.any(Array), {
      encoding: 'utf8', timeout: 1, killSignal: 'SIGKILL',
    })
    taskkillProcessTree(77, 0.5)
    expect(spawnSync).toHaveBeenLastCalledWith('taskkill', expect.any(Array), {
      stdio: 'ignore', windowsHide: true, timeout: 1, killSignal: 'SIGKILL',
    })
    createWindowsProcessInspector(0.5).signalGroup(77, 'SIGKILL')
    expect(spawnSync).toHaveBeenLastCalledWith('taskkill', expect.any(Array), {
      stdio: 'ignore', windowsHide: true, timeout: 1, killSignal: 'SIGKILL',
    })
  })

  it('carries the ordinary spawn budget into synchronous host-exit termination', async () => {
    const handle = spawnSubprocess({
      argv: [process.execPath, '-e', 'process.stdout.write(String(process.pid)); setTimeout(() => process.exit(213), 5000)'],
      cwd: process.cwd(), graceMs: 47,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
    }, { platform: 'win32' })
    let pid: number | undefined
    try {
      const [data] = await Promise.race([
        once(handle.stdout!, 'data'),
        handle.done.then(() => { throw new Error('Owned command exited before readiness') }),
      ]) as [Buffer]
      pid = Number(data.toString('utf8'))
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      vi.mocked(spawnSync).mockImplementationOnce((_file, args) => {
        expect(args).toEqual(['/PID', String(pid), '/T', '/F'])
        process.kill(pid!, 'SIGKILL')
        return {} as never
      })
      handle.terminateForHostExit()
      expect(spawnSync).toHaveBeenLastCalledWith('taskkill', expect.any(Array), {
        stdio: 'ignore', windowsHide: true, timeout: 47, killSignal: 'SIGKILL',
      })
      await handle.done
      await expect(handle.waitForExit()).resolves.toBe(true)
      pid = undefined
    } finally {
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      await handle.done
      await handle.waitForExit()
    }
  })
})
