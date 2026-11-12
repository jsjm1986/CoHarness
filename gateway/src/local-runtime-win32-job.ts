/**
 * Kernel Job Object ownership for Windows runtime trees and process-creation fencing.
 * A kill-on-close Job ends every assigned process when its last handle closes, so a
 * supervisor death of any kind cannot orphan the runtime tree it owned. Process
 * creation times fence recorded PIDs against reuse before any kill decision.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

type NativePtr = unknown
interface Kernel32 {
  openProcess(access: number, inherit: number, pid: number): NativePtr
  getCurrentProcess(): NativePtr
  getProcessTimes(process: NativePtr, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): number
  createJobObjectW(attributes: null, name: null): NativePtr
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number
  terminateJobObject(job: NativePtr, exitCode: number): number
  closeHandle(handle: NativePtr): number
  getLastError(): number
}
type NativeLibrary = { func(abi: string, name: string, result: string, args: string[]): unknown }

// AssignProcessToJobObject requires SET_QUOTA | TERMINATE on the process handle;
// QUERY_LIMITED_INFORMATION covers GetProcessTimes and exit-code reads.
const PROCESS_JOB_ACCESS = 0x0100 | 0x0001 | 0x1000
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const JobObjectExtendedLimitInformation = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144
const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16
const FILETIME_EPOCH_OFFSET_100NS = 116_444_736_000_000_000n
/** Creation-time equality window: recorded millisecond precision plus clock granularity. */
const CREATION_TOLERANCE_MS = 4

let kernel32: Kernel32 | undefined
function bindings(): Kernel32 {
  if (kernel32 === undefined) {
    const system = process.env.SystemRoot
    if (process.platform !== 'win32' || system === undefined) throw new Error('Windows Job Object ownership is unavailable.')
    const ffi = createRequire(import.meta.url)('koffi') as { load(path: string): NativeLibrary }
    const lib = ffi.load(join(system, 'System32', 'kernel32.dll'))
    kernel32 = {
      openProcess: lib.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']) as Kernel32['openProcess'],
      getCurrentProcess: lib.func('__stdcall', 'GetCurrentProcess', 'void *', []) as Kernel32['getCurrentProcess'],
      getProcessTimes: lib.func('__stdcall', 'GetProcessTimes', 'int', ['void *', 'void *', 'void *', 'void *', 'void *']) as Kernel32['getProcessTimes'],
      createJobObjectW: lib.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'void *']) as Kernel32['createJobObjectW'],
      setInformationJobObject: lib.func('__stdcall', 'SetInformationJobObject', 'int', ['void *', 'int', 'void *', 'uint32']) as Kernel32['setInformationJobObject'],
      assignProcessToJobObject: lib.func('__stdcall', 'AssignProcessToJobObject', 'int', ['void *', 'void *']) as Kernel32['assignProcessToJobObject'],
      terminateJobObject: lib.func('__stdcall', 'TerminateJobObject', 'int', ['void *', 'uint32']) as Kernel32['terminateJobObject'],
      closeHandle: lib.func('__stdcall', 'CloseHandle', 'int', ['void *']) as Kernel32['closeHandle'],
      getLastError: lib.func('__stdcall', 'GetLastError', 'uint32', []) as Kernel32['getLastError'],
    }
  }
  return kernel32
}

function isNull(pointer: NativePtr): boolean {
  return pointer === null || pointer === 0 || pointer === 0n
}

function win32Error(api: Kernel32, operation: string): Error {
  return new Error(`${operation} failed with Windows error ${api.getLastError()}`)
}

function filetimeMs(buffer: Buffer): number {
  const ticks = buffer.readBigUInt64LE(4) << 32n | buffer.readBigUInt64LE(0)
  return Number((ticks - FILETIME_EPOCH_OFFSET_100NS) / 10_000n)
}

function creationMsOf(api: Kernel32, process: NativePtr): number {
  const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8)
  if (api.getProcessTimes(process, creation, exit, kernel, user) === 0) throw win32Error(api, 'GetProcessTimes')
  return filetimeMs(creation)
}

/** One kill-on-close Job handle; closing the last handle ends every assigned process. */
export interface Win32RuntimeJob {
  /** Atomically end every process in the Job, including descendants spawned later. */
  terminate(exitCode: number): void
  /** Release the caller's Job handle; the kernel ends remaining members on last close. */
  close(): void
}

/**
 * Assign a live child to a fresh kill-on-close Job owned by this process.
 * @param pid - live direct child's process id; its handle stays open while the caller holds it.
 * @returns the caller-owned Job; it must stay open until the runtime tree should die.
 */
export function assignRuntimeKillJob(pid: number): Win32RuntimeJob {
  const api = bindings()
  const process = api.openProcess(PROCESS_JOB_ACCESS, 0, pid)
  if (isNull(process)) throw win32Error(api, `OpenProcess (pid ${String(pid)})`)
  const job = api.createJobObjectW(null, null)
  if (isNull(job)) {
    api.closeHandle(process)
    throw win32Error(api, 'CreateJobObjectW')
  }
  const information = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE)
  information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)
  if (api.setInformationJobObject(job, JobObjectExtendedLimitInformation, information, information.length) === 0) {
    const error = win32Error(api, 'SetInformationJobObject')
    api.closeHandle(job); api.closeHandle(process)
    throw error
  }
  if (api.assignProcessToJobObject(job, process) === 0) {
    const error = win32Error(api, `AssignProcessToJobObject (pid ${String(pid)})`)
    api.closeHandle(job); api.closeHandle(process)
    throw error
  }
  api.closeHandle(process)
  return {
    terminate(exitCode: number) {
      if (api.terminateJobObject(job, exitCode) === 0) throw win32Error(api, 'TerminateJobObject')
    },
    close() {
      if (api.closeHandle(job) === 0) throw win32Error(api, 'CloseHandle (job)')
    },
  }
}

/**
 * Kernel creation instant of one live process, in Unix epoch milliseconds.
 * @param pid - candidate process id.
 * @returns the creation timestamp, or undefined when no such process exists.
 */
export function win32ProcessCreationMs(pid: number): number | undefined {
  const api = bindings()
  const process = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (isNull(process)) return undefined
  try { return creationMsOf(api, process) } finally { api.closeHandle(process) }
}

/**
 * This process's own kernel creation instant, in Unix epoch milliseconds.
 * The supervisor records it beside `groupPid` so later kill paths can prove the
 * recorded PID still names the same process instead of a reused one.
 * @returns the calling process's kernel creation timestamp.
 */
export function win32CurrentProcessCreationMs(): number {
  const api = bindings()
  return creationMsOf(api, api.getCurrentProcess())
}

/**
 * Whether a live process id still names the process recorded at launch.
 * @param pid - recorded `groupPid` candidate.
 * @param expectedMs - recorded creation timestamp in Unix epoch milliseconds.
 * @returns false when the PID is dead or was reused by a differently-aged process.
 */
export function win32ProcessCreationMatches(pid: number, expectedMs: number): boolean {
  const actual = win32ProcessCreationMs(pid)
  return actual !== undefined && Math.abs(actual - expectedMs) <= CREATION_TOLERANCE_MS
}
