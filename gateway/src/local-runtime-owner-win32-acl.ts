/** Windows ACLs for Runtime ownership records and checkpoint receipts. */
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import type { KoffiFunc } from 'koffi'
import { tightenPrivateFileAcl } from './node-private-file.ts'

type NativePointer = unknown
type Verdict = 'private' | 'not-private'
type ReadDescriptor = KoffiFunc<(file: string, objectType: number, information: number, owner: Buffer,
  group: null, dacl: Buffer | null, sacl: null, descriptor: Buffer) => number>

const SE_FILE_OBJECT = 1
const OWNER_SECURITY_INFORMATION = 1
const DACL_SECURITY_INFORMATION = 4
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
const ACL_REVISION = 2
const FILE_ALL_ACCESS = 0x001f01ff
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
    initAcl: access.func('__stdcall', 'InitializeAcl', 'int', ['void *', 'uint32', 'uint32']) as
      (acl: Buffer, bytes: number, revision: number) => number,
    allow: access.func('__stdcall', 'AddAccessAllowedAce', 'int', ['void *', 'uint32', 'uint32', 'void *']) as
      (acl: Buffer, revision: number, mask: number, trustee: Buffer) => number,
    setDacl: access.func('__stdcall', 'SetNamedSecurityInfoW', 'uint32',
      ['str16', 'int', 'uint32', 'void *', 'void *', 'void *', 'void *']) as
      KoffiFunc<(file: string, type: number, info: number, owner: null, group: null, acl: Buffer, sacl: null) => number>,
    aclInformation: access.func('__stdcall', 'GetAclInformation', 'int', ['void *', 'void *', 'uint32', 'int']) as
      (acl: NativePointer, info: Buffer, size: number, informationClass: number) => number,
    validSid: access.func('__stdcall', 'IsValidSid', 'int', ['void *']) as (sid: NativePointer) => number,
    sidLength: access.func('__stdcall', 'GetLengthSid', 'uint32', ['void *']) as (sid: NativePointer) => number,
    release: kernel.func('__stdcall', 'LocalFree', 'void *', ['void *']) as (descriptor: NativePointer) => NativePointer,
  }
}

type Bindings = ReturnType<typeof loadBindings>
let bindings: Bindings | undefined

function nativeBindings(): Bindings | undefined {
  const root = process.env.SystemRoot
  if (process.platform !== 'win32' || root === undefined || !isAbsolute(root)) return undefined
  try { return bindings ??= loadBindings(root) }
  catch { return undefined /* The private-file PowerShell operations cover hosts without native bindings. */ }
}

function ownerSid(api: Bindings, owner: NativePointer): Buffer | undefined {
  if (owner === null || api.validSid(owner) === 0) return undefined
  const bytes = api.sidLength(owner)
  if (bytes < SID_HEADER_BYTES || bytes > MAX_SID_BYTES) return undefined
  return api.view(owner, bytes)
}

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
  const sid = ownerSid(api, owner)
  if (sid === undefined) return undefined
  const info = Buffer.alloc(12)
  if (api.aclInformation(dacl, info, info.length, ACL_SIZE_INFORMATION_CLASS) === 0) return undefined
  const count = info.readUInt32LE(0)
  if (count === 0) return 'not-private'
  if (count > MAX_PRIVATE_ACE_COUNT) return undefined
  const bytes = info.readUInt32LE(4)
  if (bytes < ACL_HEADER_BYTES || bytes > 0xffff) return undefined
  return evaluateAcl(api.view(dacl, bytes), count, sid)
}

/**
 * Read the owner and DACL of an ordinary Windows file or directory without starting PowerShell.
 * @param file - path checked for replacement links by the owner-file reader.
 * @param signal - cancellation reported after the native read releases its descriptor.
 * @returns an authoritative verdict for standard ACLs, or undefined for unavailable or unsupported reads.
 */
export async function probeNativeWindowsOwnerAcl(file: string, signal?: AbortSignal): Promise<Verdict | undefined> {
  signal?.throwIfAborted()
  const api = nativeBindings()
  if (api === undefined) return undefined
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

/**
 * Protect a newly created, unpublished regular file inside the verified Runtime ownership directory.
 * The explicit, non-inheritable FullControl grants belong to its actual owner, LocalSystem and Administrators.
 * @param file - exclusive temporary path owned by the publishing lease.
 */
export async function protectRuntimeOwnerFile(file: string): Promise<void> {
  if (process.platform !== 'win32') return
  const api = nativeBindings()
  if (api === undefined) return tightenPrivateFileAcl(file)
  const owner = api.pointer(), descriptor = api.pointer()
  try {
    const status = await new Promise<number>((resolve, reject) => {
      api.readDescriptor.async(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, owner, null, null, null, descriptor,
        (error, code) => error ? reject(error) : resolve(code))
    })
    if (status !== 0) throw new Error(`GetNamedSecurityInfoW failed for Runtime owner file (Win32 ${status})`)
    if (api.decodePointer(descriptor) === null) throw new Error('Runtime ownership file has no security descriptor')
    const sid = ownerSid(api, api.decodePointer(owner))
    if (sid === undefined) throw new Error('Runtime ownership file has no valid owner SID')
    const trustees = [sid, ...[localSystem, administrators].filter(trustee => !trustee.equals(sid))]
    const bytes = ACL_HEADER_BYTES + trustees.reduce((sum, trustee) => sum + ACE_SID_OFFSET + trustee.length, 0)
    const acl = Buffer.alloc(bytes)
    if (api.initAcl(acl, bytes, ACL_REVISION) === 0) throw new Error('Could not initialize the Runtime ownership DACL')
    for (const trustee of trustees) {
      if (api.allow(acl, ACL_REVISION, FILE_ALL_ACCESS, trustee) === 0) throw new Error('Could not add a Runtime owner file access rule')
    }
    const information = (PROTECTED_DACL_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION) >>> 0
    const result = await new Promise<number>((resolve, reject) => {
      api.setDacl.async(file, SE_FILE_OBJECT, information,
        null, null, acl, null, (error, code) => error ? reject(error) : resolve(code))
    })
    if (result !== 0) throw new Error(`SetNamedSecurityInfoW failed for Runtime owner file (Win32 ${result})`)
  } finally {
    const allocation = api.decodePointer(descriptor)
    if (allocation !== null) api.release(allocation)
  }
}
