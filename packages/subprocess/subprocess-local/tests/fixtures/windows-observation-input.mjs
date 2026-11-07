/** Win32 API inputs backed by real POSIX process identities for the Loader terminal regression. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import childProcess from 'node:child_process'

export function installWindowsObservationInput(inspectorEntry, posix, ownedPids) {
  const require = createRequire(inspectorEntry), koffi = require('koffi')
  const originalLoad = koffi.load, originalSpawnSync = childProcess.spawnSync
  const originalCommand = childProcess.execFileSync
  let unavailable = false, error = 18, nextHandle = 2000n, row = 0, rows = []
  const handles = new Map()
  const writeRow = entry => {
    const value = rows[row]
    if (value === undefined) { error = 18; return 0 }
    koffi.encode(entry, 'PROCESSENTRY32W', value)
    return 1
  }
  const operations = {
    GetLastError: () => error,
    CreateToolhelp32Snapshot: () => {
      rows = originalCommand('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => {
        const [pid, parentPid] = line.trim().split(/\s+/u).map(Number)
        assert.ok(Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid))
        return { th32ProcessID: pid, th32ParentProcessID: parentPid }
      })
      return 1000n
    },
    Process32FirstW: (_snapshot, entry) => { row = 0; return writeRow(entry) },
    Process32NextW: (_snapshot, entry) => { row++; return writeRow(entry) },
    OpenProcess: (_access, _inherit, pid) => {
      if (unavailable && ownedPids().includes(pid)) { error = 5; return 0n }
      const identity = posix.snapshot().tree(pid).find(member => member.pid === pid)
      if (identity === undefined || !posix.isAlive(identity)) { error = 87; return 0n }
      const handle = nextHandle++
      handles.set(handle, identity)
      return handle
    },
    GetProcessTimes: (handle, creation) => {
      const identity = handles.get(handle)
      assert.ok(identity !== undefined)
      const stamp = createHash('sha256').update(identity.started).digest()
      koffi.encode(creation, 'FILETIME', { dwHighDateTime: stamp.readUInt32LE(4), dwLowDateTime: stamp.readUInt32LE(0) })
      return 1
    },
    WaitForSingleObject: handle => {
      const identity = handles.get(handle)
      assert.ok(identity !== undefined)
      return posix.isAlive(identity) ? 0x102 : 0
    },
    CloseHandle: handle => { handles.delete(handle); return 1 },
  }
  koffi.load = function (library, ...args) {
    if (library !== 'kernel32.dll') return originalLoad.call(this, library, ...args)
    return { func: (_convention, name) => {
      assert.ok(name in operations, `Unexpected Win32 operation: ${name}`)
      return operations[name]
    } }
  }
  childProcess.spawnSync = (...args) => {
    if (args[0] !== 'taskkill') return originalSpawnSync(...args)
    const pid = Number(args[1][1])
    assert.ok(ownedPids().includes(pid), 'Only the fixture terminal and its captured descendant may receive taskkill')
    const identity = posix.snapshot().tree(pid).find(member => member.pid === pid)
    if (identity !== undefined) posix.signalProcess(identity, args[1].includes('/F') ? 'SIGKILL' : 'SIGTERM')
    return { status: 0, signal: null, stdout: null, stderr: null, pid: 0, output: [] }
  }
  syncBuiltinESMExports()
  return {
    setUnavailable(value) { unavailable = value },
    restore() { koffi.load = originalLoad; childProcess.spawnSync = originalSpawnSync; syncBuiltinESMExports() },
  }
}
