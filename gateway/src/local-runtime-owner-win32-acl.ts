/** Native Windows ACL reads for private Runtime ownership records. */
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import type { KoffiFunc } from 'koffi'

type NativePointer = unknown
type Verdict = 'private' | 'not-private'
type ReadDescriptor = KoffiFunc<(file: string, objectType: number, information: number, owner: Buffer,
  group: null, dacl: Buffer, sacl: null, descriptor: Buffer) => number>

const SE_FILE_OBJECT = 1
const OWNER_SECURITY_INFORMATION = 1
const DACL_SECURITY_INFORMATION = 4
const ACL_SIZE_INFORMATION_CLASS = 2
const ACL_HEADER_BYTES = 8
const ACE_HEADER_BYTES = 4
const ACE_SID_OFFSET = 8
const SID_HEADER_BYTES = 8
const MAX_SID_BYTES = 68
const ACCESS_ALLOWED_ACE = 0
const ACCESS_DENIED_ACE = 1
const MAX_PRIVATE_ACE_COUNT = 64

const localSystem = Buffer.from('010100000000000512000000', 'hex') // S-1-5-18
const administrators = Buffer.from('01020000000000052000000020020000', 'hex') // S-1-5-32-544

function loadBindings(systemRoot: string) {
  const ffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
  const access = ffi.load(join(systemRoot, 'System32', 'advapi32.dll'))
  const kernel = ffi.load(join(systemRoot, 'System32', 'kernel32.dll'))
  return {
    pointer: () => Buffer.alloc(ffi.sizeof('void *')),
    decodePointer: (slot: Buffer): NativePointer => ffi.decode(slot, 'void *'),
    view: (address: NativePointer, length: number) => Buffer.from(ffi.view(address, length)),
    readDescriptor: access.func('__stdcall', 'GetNamedSecurityInfoW', 'uint32',
      ['str16', 'int', 'uint32', 'void *', 'void *', 'void *', 'void *', 'void *']) as ReadDescriptor,
    aclInformation: access.func('__stdcall', 'GetAclInformation', 'int', ['void *', 'void *', 'uint32', 'int']) as
      (acl: NativePointer, info: Buffer, size: number, informationClass: number) => number,
    validSid: access.func('__stdcall', 'IsValidSid', 'int', ['void *']) as (sid: NativePointer) => number,
    sidLength: access.func('__stdcall', 'GetLengthSid', 'uint32', ['void *']) as (sid: NativePointer) => number,
    release: kernel.func('__stdcall', 'LocalFree', 'void *', ['void *']) as (descriptor: NativePointer) => NativePointer,
  }
}

type Bindings = ReturnType<typeof loadBindings>
let bindings: Bindings | undefined

function evaluateAcl(acl: Buffer, count: number, owner: Buffer): Verdict | undefined {
  let offset = ACL_HEADER_BYTES
  for (let index = 0; index < count; index++) {
    if (offset + ACE_HEADER_BYTES > acl.length) return undefined
    const type = acl[offset]
    const end = offset + acl.readUInt16LE(offset + 2)
    if (end > acl.length || end < offset + ACE_SID_OFFSET + SID_HEADER_BYTES || end % 4 !== 0) return undefined
    if (type === ACCESS_DENIED_ACE) return 'not-private'
    if (type !== ACCESS_ALLOWED_ACE) return undefined
    const sid = acl.subarray(offset + ACE_SID_OFFSET, end)
    if (sid[0] !== 1 || sid.length > MAX_SID_BYTES || sid.length !== SID_HEADER_BYTES + 4 * sid[1]!) return undefined
    if (!sid.equals(owner) && !sid.equals(localSystem) && !sid.equals(administrators)) return 'not-private'
    offset = end
  }
  return offset === acl.length ? 'private' : undefined
}

function readVerdict(api: Bindings, owner: NativePointer, dacl: NativePointer): Verdict | undefined {
  if (owner === null || dacl === null) return 'not-private'
  if (api.validSid(owner) === 0) return undefined
  const ownerLength = api.sidLength(owner)
  if (ownerLength < SID_HEADER_BYTES || ownerLength > MAX_SID_BYTES) return undefined
  const info = Buffer.alloc(12)
  if (api.aclInformation(dacl, info, info.length, ACL_SIZE_INFORMATION_CLASS) === 0) return undefined
  const count = info.readUInt32LE(0)
  if (count === 0) return 'not-private'
  if (count > MAX_PRIVATE_ACE_COUNT) return undefined
  const bytes = info.readUInt32LE(4)
  if (bytes < ACL_HEADER_BYTES || bytes > 0xffff) return undefined
  return evaluateAcl(api.view(dacl, bytes), count, api.view(owner, ownerLength))
}

/**
 * Read the owner and DACL of an ordinary Windows file or directory without starting PowerShell.
 * @param file - path checked for replacement links by the owner-file reader.
 * @param signal - cancellation reported after the native read releases its descriptor.
 * @returns an authoritative verdict for standard ACLs, or undefined for unavailable or unsupported reads.
 */
export async function probeNativeWindowsOwnerAcl(file: string, signal?: AbortSignal): Promise<Verdict | undefined> {
  signal?.throwIfAborted()
  const systemRoot = process.env.SystemRoot
  if (process.platform !== 'win32' || systemRoot === undefined || !isAbsolute(systemRoot)) return undefined
  try { bindings ??= loadBindings(systemRoot) }
  catch { return undefined /* The caller uses its regular ACL probe when native bindings cannot load. */ }
  const api = bindings
  const descriptor = api.pointer(), owner = api.pointer(), dacl = api.pointer()
  try {
    const status = await new Promise<number | undefined>(resolve => {
      api.readDescriptor.async(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        owner, null, dacl, null, descriptor, (error, code) => resolve(error ? undefined : code))
    }).catch(() => undefined)
    signal?.throwIfAborted()
    if (status !== 0 || api.decodePointer(descriptor) === null) return undefined
    return readVerdict(api, api.decodePointer(owner), api.decodePointer(dacl))
  } finally {
    // Owner and DACL point into this allocation. The verdict holds no borrowed memory.
    const allocation = api.decodePointer(descriptor)
    if (allocation !== null) api.release(allocation)
  }
}
