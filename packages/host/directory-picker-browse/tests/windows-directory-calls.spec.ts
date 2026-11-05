/** Native Windows records use real Koffi layouts and deterministic syscall results. */
import { beforeEach, expect, it, vi } from 'vitest'
import { loadWindowsDirectoryCalls } from '../src/windows-directory-calls.ts'

const state = vi.hoisted(() => ({
  loads: [] as string[], unloads: [] as string[], symbols: [] as string[],
  loadFailure: '', symbolFailure: '', unloadFailure: '', nativeFailure: undefined as unknown,
  rootHandle: 11, childHandle: 12 as number | undefined, childStatus: 0, queryStatus: 0, inspectResult: 1, closeResult: 1,
  attributes: 0x10, malformed: '', rows: [{ name: 'directory', flags: 0x10 }] as { name: string; flags: number }[],
  creates: [] as unknown[][], queries: [] as unknown[][],
}))

vi.mock('koffi', async (original) => {
  const actual = (await original<typeof import('koffi')>()).default
  return { default: {
    ...actual,
    load: (name: string) => {
      state.loads.push(name)
      if (name === state.loadFailure) throw new Error('load unavailable')
      return {
        unload: () => { state.unloads.push(name); if (name === state.unloadFailure) throw new Error('unload unavailable') },
        func: (_convention: string, symbol: string) => {
          state.symbols.push(symbol)
          if (symbol === state.symbolFailure) throw new Error('symbol unavailable')
          return { async: (...parameters: unknown[]) => {
            const callback = parameters.pop() as (error: unknown, value: number) => void
            queueMicrotask(() => {
              try {
                if (state.nativeFailure !== undefined) { callback(state.nativeFailure, 0); return }
                switch (symbol) {
                  case 'CreateFileW': callback(null, state.rootHandle); return
                  case 'CloseHandle': callback(null, state.closeResult); return
                  case 'NtCreateFile': {
                    state.creates.push(parameters)
                    const output = parameters[0] as number[]
                    if (state.childHandle === undefined) output.length = 0
                    else output[0] = state.childHandle
                    callback(null, state.childStatus); return
                  }
                  case 'GetFileInformationByHandle': {
                    const info = parameters[1] as Buffer
                    info.writeUInt32LE(state.attributes, 0); info.writeUInt32LE(7, 28)
                    info.writeUInt32LE(1, 44); info.writeUInt32LE(42, 48)
                    callback(null, state.inspectResult); return
                  }
                  case 'NtQueryDirectoryFile': {
                    state.queries.push(parameters)
                    const io = parameters[4] as Buffer, buffer = parameters[5] as Buffer
                    // FILE_DIRECTORY_INFORMATION has a 64-byte header on both Windows pointer widths.
                    const header = 64
                    let bytes = 0
                    for (const [index, row] of state.rows.entries()) {
                      const encoded = Buffer.from(row.name, 'utf16le'), size = Math.ceil((header + encoded.length) / 8) * 8
                      buffer.writeUInt32LE(index === state.rows.length - 1 ? 0 : size, bytes)
                      buffer.writeUInt32LE(row.flags, bytes + 56)
                      buffer.writeUInt32LE(encoded.length, bytes + 60)
                      encoded.copy(buffer, bytes + header); bytes += size
                    }
                    const length = 60
                    if (state.malformed === 'zero-name') buffer.writeUInt32LE(0, length)
                    if (state.malformed === 'odd-name') buffer.writeUInt32LE(3, length)
                    if (state.malformed === 'long-name') buffer.writeUInt32LE(bytes, length)
                    if (state.malformed === 'short-next') buffer.writeUInt32LE(1, 0)
                    if (state.malformed === 'long-next') buffer.writeUInt32LE(bytes + 8, 0)
                    if (state.malformed === 'truncated-next') buffer.writeUInt32LE(bytes, 0)
                    const information = state.malformed === 'short-count' ? 1 : state.malformed === 'long-count' ? buffer.length + 1
                      : state.malformed === 'unsafe-count' ? 1n << 63n : bytes
                    const pointerBytes = actual.sizeof('uintptr')
                    if (pointerBytes === 8) io.writeBigUInt64LE(BigInt(information), pointerBytes)
                    else io.writeUInt32LE(Number(BigInt(information) & 0xffffffffn), pointerBytes)
                    callback(null, state.queryStatus); return
                  }
                  default: throw new Error(`Unexpected Windows symbol ${symbol}`)
                }
              } catch (error) { callback(error, 0) }
            })
          } }
        },
      }
    },
  } }
})

beforeEach(() => {
  state.loads.length = 0; state.unloads.length = 0; state.symbols.length = 0; state.creates.length = 0; state.queries.length = 0
  state.loadFailure = ''; state.symbolFailure = ''; state.unloadFailure = ''; state.nativeFailure = undefined
  state.rootHandle = 11; state.childHandle = 12; state.childStatus = 0; state.queryStatus = 0
  state.inspectResult = 1; state.closeResult = 1; state.attributes = 0x10; state.malformed = ''
  state.rows = [{ name: 'directory', flags: 0x10 }]
})

it('opens roots and one UTF-16 child with synchronous, handle-relative, no-reparse options', async () => {
  const calls = await loadWindowsDirectoryCalls()
  try {
    expect(await calls.openRoot('\\\\?\\C:\\')).toBe(11)
    expect(await calls.child(11, '目录', false)).toBe(12)
    const request = state.creates[0]
    expect(request?.[1]).toBe(0x001000a4)
    expect(request?.[2]).toMatchObject({ RootDirectory: 11, Attributes: 0x1040,
      ObjectName: { Length: 4, MaximumLength: 4, Buffer: Buffer.from('目录', 'utf16le') } })
    expect(request?.slice(6, 9)).toEqual([7, 1, 0x00200021])
    await calls.child(11, 'created', true)
    expect(state.creates[1]?.[7]).toBe(2)
    expect(state.creates[1]?.[1]).toBe(0)
    expect(await calls.reader(11)).toBe(12)
    expect(state.creates[2]?.[1]).toBe(0x00100081)
    expect(state.creates[2]?.[2]).toMatchObject({ RootDirectory: 11, ObjectName: { Buffer: Buffer.from('', 'utf16le') } })
    expect(await calls.identity(11)).toEqual({ device: '7', inode: String(1n << 32n | 42n) })
    await calls.close(12)
  } finally { calls.unload() }
  expect(state.unloads).toEqual(['ntdll.dll', 'kernel32.dll'])
})

it('reads linked records by handle, preserves Unicode and separates reparse entries from real directories', async () => {
  state.rows = [{ name: '.', flags: 0x10 }, { name: '..', flags: 0x10 }, { name: '目录', flags: 0x10 },
    { name: 'link', flags: 0x410 }, { name: 'file', flags: 0 }]
  const calls = await loadWindowsDirectoryCalls()
  try {
    expect(await calls.read(11)).toEqual([
      { name: '目录', isDirectory: true, isSymbolicLink: false },
      { name: 'link', isDirectory: false, isSymbolicLink: true },
      { name: 'file', isDirectory: false, isSymbolicLink: false },
    ])
    expect(state.queries[0]?.[0]).toBe(11)
    state.queryStatus = 0x80000006 | 0
    expect(await calls.read(11)).toBeNull()
  } finally { calls.unload() }
})

it.each(['', '.', '..', 'nested/child', 'nested\\child', 'prefix\0suffix', 'x'.repeat(32768)])('refuses invalid native child names (%#)', async (name) => {
  const calls = await loadWindowsDirectoryCalls()
  try { await expect(calls.child(11, name, false)).rejects.toThrow('one nonempty name'); expect(state.creates).toEqual([]) }
  finally { calls.unload() }
})

it.each(['NUL', 'COM¹', 'LPT9.txt', 'trailing.', 'trailing ', 'file:stream', 'wild*card', 'control\x01'])('refuses creation of non-Win32 child names (%#)', async (name) => {
  const calls = await loadWindowsDirectoryCalls()
  try { await expect(calls.child(11, name, true)).rejects.toThrow('valid Windows filename'); expect(state.creates).toEqual([]) }
  finally { calls.unload() }
})

it.each(['short-count', 'long-count', 'unsafe-count', 'zero-name', 'odd-name', 'long-name', 'short-next', 'long-next', 'truncated-next'])('refuses malformed native %s records', async (malformed) => {
  const calls = await loadWindowsDirectoryCalls(); state.malformed = malformed
  try { await expect(calls.read(11)).rejects.toThrow(/invalid|truncated/) }
  finally { calls.unload() }
})

it.each([0, -1, undefined])('refuses a successful native open without an owned handle (%s)', async (handle) => {
  const calls = await loadWindowsDirectoryCalls(); state.childHandle = handle
  try { await expect(calls.child(11, 'child', false)).rejects.toThrow('no handle') }
  finally { calls.unload() }
})

it('preserves native collisions and read failures rather than reporting EOF', async () => {
  const calls = await loadWindowsDirectoryCalls()
  try {
    state.childStatus = 0xc0000035 | 0
    await expect(calls.child(11, 'existing', true)).rejects.toMatchObject({ code: 'EEXIST', syscall: 'NtCreateFile' })
    state.queryStatus = 0xc0000022 | 0
    await expect(calls.read(11)).rejects.toMatchObject({ code: 'EIO', syscall: 'NtQueryDirectoryFile' })
    state.nativeFailure = new Error('FFI call unavailable')
    await expect(calls.read(11)).rejects.toThrow('FFI call unavailable')
    state.nativeFailure = 'FFI transport unavailable'
    await expect(calls.read(11)).rejects.toMatchObject({ message: 'Windows directory call failed', cause: 'FFI transport unavailable' })
  } finally { calls.unload() }
})

it.each([0, 0x410])('refuses non-directory or reparse identities (%s)', async (flags) => {
  const calls = await loadWindowsDirectoryCalls(); state.attributes = flags
  try { await expect(calls.identity(11)).rejects.toThrow('not a real directory') }
  finally { calls.unload() }
})

it('keeps root, identity and close failures visible', async () => {
  const calls = await loadWindowsDirectoryCalls()
  try {
    state.rootHandle = -1
    await expect(calls.openRoot('\\\\?\\C:\\')).rejects.toThrow('root could not be opened')
    state.inspectResult = 0
    await expect(calls.identity(11)).rejects.toThrow('identity could not be read')
    state.closeResult = 0
    await expect(calls.close(11)).rejects.toThrow('could not close')
  } finally { calls.unload() }
})

it.each(['bad/name', 'bad\\name', 'bad\0name'])('refuses a native directory record containing a non-leaf name (%#)', async (name) => {
  state.rows = [{ name, flags: 0x10 }]
  const calls = await loadWindowsDirectoryCalls()
  try { await expect(calls.read(11)).rejects.toThrow('invalid entry name') }
  finally { calls.unload() }
})

it.each(['load', 'symbol', 'cleanup'] as const)('releases partial native setup after a %s failure', async (kind) => {
  if (kind === 'load') state.loadFailure = 'ntdll.dll'
  else state.symbolFailure = 'NtCreateFile'
  if (kind === 'cleanup') state.unloadFailure = 'ntdll.dll'
  await expect(loadWindowsDirectoryCalls()).rejects.toThrow(kind === 'cleanup' ? 'setup and cleanup failed' : 'unavailable')
  expect(state.unloads).toEqual(kind === 'load' ? ['kernel32.dll'] : ['ntdll.dll', 'kernel32.dll'])
})
