/** Win32 observation failures retain terminal ownership until exact process reads recover. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { createWindowsProcessInspector } from '../src/windows-inspector.ts'
import { LocalTerminalHandle } from '../src/terminal.ts'

const native = vi.hoisted(() => ({
  failure: '', error: 18, row: 0, childAlive: true, rootAlive: true,
  closed: [] as bigint[], signals: [] as number[],
}))

vi.mock('@deepseek-ai/dsh-lazy-require', async () => {
  const { default: koffi } = await import('koffi')
  const rows = () => [
    ...native.rootAlive ? [{ th32ProcessID: 123, th32ParentProcessID: 0 }] : [],
    ...native.childAlive ? [{ th32ProcessID: 124, th32ParentProcessID: native.rootAlive ? 123 : 0 }] : [],
  ]
  const operations = {
    GetLastError: () => native.error,
    CreateToolhelp32Snapshot: () => {
      if (native.failure === 'snapshot') { native.error = 5; return -1n }
      return 1000n
    },
    Process32FirstW: (_handle: unknown, entry: unknown) => {
      native.row = 0
      if (native.failure === 'first') { native.error = 5; return 0 }
      const row = rows()[native.row]
      if (row === undefined) { native.error = 18; return 0 }
      koffi.encode(entry, 'PROCESSENTRY32W', row)
      return 1
    },
    Process32NextW: (_handle: unknown, entry: unknown) => {
      if (native.failure === 'next') { native.error = 5; return 0 }
      native.row++
      const row = rows()[native.row]
      if (row === undefined) { native.error = 18; return 0 }
      koffi.encode(entry, 'PROCESSENTRY32W', row)
      return 1
    },
    OpenProcess: (_access: number, _inherit: number, pid: number) => {
      if (pid === 124 && native.failure === 'open') { native.error = 5; return 0n }
      if (pid === 124 && !native.childAlive || pid === 123 && !native.rootAlive) { native.error = 87; return 0n }
      return BigInt(pid)
    },
    GetProcessTimes: (handle: bigint, creation: unknown) => {
      if (handle === 124n && native.failure === 'times') { native.error = 5; return 0 }
      koffi.encode(creation, 'FILETIME', { dwHighDateTime: 0, dwLowDateTime: Number(handle) })
      return 1
    },
    WaitForSingleObject: (handle: bigint) => {
      if (handle === 124n && native.failure === 'wait') { native.error = 6; return 0xFFFFFFFF }
      if (handle === 124n && native.failure === 'exited') return 0
      return 0x102
    },
    CloseHandle: (handle: bigint) => { native.closed.push(handle); return 1 },
  }
  return {
    createLazyRequire: () => () => ({ ...koffi,
      load: () => ({ func: (_callingConvention: string, name: string) => {
        if (!(name in operations)) throw new Error(`Unexpected Win32 binding: ${name}`)
        return operations[name as keyof typeof operations]
      } }),
    }),
  }
})

beforeEach(() => {
  native.failure = ''; native.error = 18; native.row = 0
  native.childAlive = true; native.rootAlive = true
  native.closed.length = 0; native.signals.length = 0
})

describe('Win32 process observation failure', () => {
  it.each([
    ['open', 'OpenProcess failed (Win32 5)'],
    ['times', 'GetProcessTimes failed (Win32 5)'],
    ['wait', 'WaitForSingleObject failed (Win32 6)'],
  ] as const)('refuses an unreadable exact identity after %s failure', (failure, message) => {
    const inspector = createWindowsProcessInspector(1000)
    native.failure = failure
    expect(() => inspector.isAlive({ pid: 124, started: '0:124' })).toThrow(message)
    expect(() => inspector.snapshot().alive({ pid: 124, started: '0:124' })).toThrow(message)
    expect(() => { inspector.signalProcess({ pid: 124, started: '0:124' }, 'SIGKILL') }).toThrow(message)
    if (failure !== 'open') expect(native.closed).toEqual([124n, 124n, 124n])
  })

  it.each([
    ['snapshot', 'CreateToolhelp32Snapshot failed (Win32 5)'],
    ['first', 'Process32FirstW failed (Win32 5)'],
    ['next', 'Process32NextW failed (Win32 5)'],
  ] as const)('refuses an incomplete process enumeration after %s failure', (failure, message) => {
    native.failure = failure
    expect(() => createWindowsProcessInspector(1000).snapshot().tree(123)).toThrow(message)
    expect(native.closed).toEqual(failure === 'snapshot' ? [] : [1000n])
  })

  it('distinguishes a missing process from a failed identity read', () => {
    const inspector = createWindowsProcessInspector(1000)
    expect(inspector.snapshot().tree(123)).toEqual([{ pid: 124, started: '0:124' }, { pid: 123, started: '0:123' }])
    expect(inspector.isAlive({ pid: 124, started: 'stale' })).toBe(false)
    native.failure = 'exited'
    expect(inspector.isAlive({ pid: 124, started: '0:124' })).toBe(false)
    native.failure = ''
    native.childAlive = false
    expect(inspector.isAlive({ pid: 124, started: '0:124' })).toBe(false)
    native.rootAlive = false
    expect(inspector.snapshot().tree(123)).toEqual([])
  })

  it.each(['open', 'times', 'wait', 'snapshot', 'first', 'next'])('retains a root-exited terminal after %s failure and permits verified retry', async (failure) => {
    const inspector = createWindowsProcessInspector(1000)
    inspector.signalProcess = (identity) => {
      if (!inspector.isAlive(identity)) return
      native.signals.push(identity.pid)
      if (identity.pid === 124) native.childAlive = false
    }
    let exited: ((event: { exitCode: number }) => void) | undefined
    const disposed = vi.fn(), quiescence = vi.fn()
    const terminal = { pid: 123, onData: () => ({ dispose: disposed }),
      onExit: (listener: typeof exited) => { exited = listener; return { dispose: disposed } },
    } as unknown as IPty
    const handle = new LocalTerminalHandle(terminal, inspector, 1, 'win32', undefined, undefined, undefined, quiescence)
    handle.output.resume()
    try {
      await handle.inspectForeground()
      native.rootAlive = false
      exited!({ exitCode: 0 })
      native.failure = failure
      await expect(handle.terminate()).rejects.toThrow('failed (Win32')
      expect(native.childAlive).toBe(true)
      expect(quiescence).not.toHaveBeenCalled()
      expect(disposed).not.toHaveBeenCalled()
      native.failure = ''
      await handle.terminate()
      expect(native.childAlive).toBe(false)
      expect(native.signals).toEqual([124])
      expect(quiescence).toHaveBeenCalledOnce()
    } finally {
      native.failure = ''; native.childAlive = false; native.rootAlive = false
      exited?.({ exitCode: 0 })
      await handle.terminate()
    }
  })
})
