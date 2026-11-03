/** Documented Windows handle-relative directory calls with request-owned FFI libraries. */
import type { KoffiFunc } from 'koffi'
import type { DirectoryObjectIdentity, PinnedDirectoryEntry } from './pinned-directory.ts'

type Handle = number | bigint
const NO_MORE_FILES = 0x80000006
const NAME_COLLISION = 0xc0000035
const MAX_UNICODE_BYTES = 0xfffe

/** Native handles borrowed until each asynchronous syscall completes. */
export interface WindowsDirectoryCalls {
  /** Open a drive or share root; no user-controlled parent path is traversed. */
  openRoot(path: string): Promise<Handle>
  /** Open or create one child relative to an already opened parent, refusing reparse traversal. */
  child(parent: Handle, name: string, create: boolean): Promise<Handle>
  /** Open an independent synchronous reader on the selected directory object. */
  reader(parent: Handle): Promise<Handle>
  /** Capture the opened real directory's volume and file identifiers. */
  identity(handle: Handle): Promise<DirectoryObjectIdentity>
  /** Read the next bounded batch by handle; null marks native end of directory. */
  read(handle: Handle): Promise<PinnedDirectoryEntry[] | null>
  /** Release one handle after its consumers finish. */
  close(handle: Handle): Promise<void>
  /** Unload both libraries after every handle closes. */
  unload(): void
}

function nativeError(operation: string, status: number): Error {
  return Object.assign(new Error(`${operation} failed (NTSTATUS 0x${status.toString(16)})`), {
    code: status === NAME_COLLISION ? 'EEXIST' : 'EIO', syscall: operation, nativeStatus: status,
  })
}

/**
 * Bind kernel32 and ntdll without registering process-global named FFI types.
 * @returns Request-owned directory calls; setup failure releases loaded libraries.
 */
export async function loadWindowsDirectoryCalls(): Promise<WindowsDirectoryCalls> {
  const koffi = (await import('koffi')).default
  const libraries: ReturnType<typeof koffi.load>[] = []
  const unload = (): void => {
    const failures: unknown[] = []
    for (const library of libraries.toReversed()) {
      try { library.unload() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Windows directory libraries could not unload')
  }
  try {
    const kernel = koffi.load('kernel32.dll'); libraries.push(kernel)
    const nt = koffi.load('ntdll.dll'); libraries.push(nt)
    const unicode = koffi.struct({ Length: 'uint16', MaximumLength: 'uint16', Buffer: 'void*' })
    const attributes = koffi.struct({ Length: 'uint32', RootDirectory: 'intptr', ObjectName: koffi.pointer(unicode),
      Attributes: 'uint32', SecurityDescriptor: 'void*', SecurityQualityOfService: 'void*' })
    const statusBlock = koffi.struct({ Status: 'intptr', Information: 'uintptr' })
    const entry = koffi.struct({ NextEntryOffset: 'uint32', FileIndex: 'uint32', CreationTime: 'int64',
      LastAccessTime: 'int64', LastWriteTime: 'int64', ChangeTime: 'int64', EndOfFile: 'int64',
      AllocationSize: 'int64', FileAttributes: 'uint32', FileNameLength: 'uint32', FileName: koffi.array('uint16', 1) })
    const filenameOffset = koffi.offsetof(entry, 'FileName')
    const createRoot = kernel.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'intptr']) as KoffiFunc<
      (path: string, access: number, share: number, security: null, creation: number, flags: number, template: Handle) => Handle
    >
    const inspect = kernel.func('__stdcall', 'GetFileInformationByHandle', 'int', ['intptr', 'void*']) as KoffiFunc<(handle: Handle, info: Buffer) => number>
    const release = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as KoffiFunc<(handle: Handle) => number>
    interface ObjectAttributes {
      Length: number
      RootDirectory: Handle
      ObjectName: { Length: number; MaximumLength: number; Buffer: Buffer }
      Attributes: number
      SecurityDescriptor: null
      SecurityQualityOfService: null
    }
    const createChild = nt.func('__stdcall', 'NtCreateFile', 'int32', [koffi.out(koffi.pointer('intptr')), 'uint32',
      koffi.pointer(attributes), 'void*', 'void*', 'uint32', 'uint32', 'uint32', 'uint32', 'void*', 'uint32']) as KoffiFunc<
      (output: Handle[], access: number, attrs: ObjectAttributes, status: Buffer, allocation: null, flags: number,
        share: number, disposition: number, options: number, ea: null, eaSize: number) => number
    >
    const query = nt.func('__stdcall', 'NtQueryDirectoryFile', 'int32', ['intptr', 'intptr', 'void*', 'void*', 'void*',
      'void*', 'uint32', 'uint32', 'uint8', 'void*', 'uint8']) as KoffiFunc<
      (handle: Handle, event: Handle, apc: null, context: null, status: Buffer, entries: Buffer, size: number,
        informationClass: number, single: number, pattern: null, restart: number) => number
    >
    const invoke = <Args extends unknown[], Result extends Handle>(
      call: KoffiFunc<(...args: Args) => Result>, args: Args,
    ): Promise<Result> => new Promise((resolve, reject) => {
      call.async(...args, (error: unknown, result: Result) => {
        if (error !== null) reject(error instanceof Error ? error : new Error('Windows directory call failed', { cause: error }))
        else resolve(result)
      })
    })
    const open = async (parent: Handle, name: string, disposition: number, access: number, synchronous: boolean): Promise<Handle> => {
      const encoded = Buffer.from(name, 'utf16le'), output: Handle[] = [0], io = Buffer.alloc(koffi.sizeof(statusBlock))
      const attrs: ObjectAttributes = { Length: koffi.sizeof(attributes), RootDirectory: parent,
        ObjectName: { Length: encoded.length, MaximumLength: encoded.length, Buffer: encoded },
        Attributes: 0x40 | 0x1000, SecurityDescriptor: null, SecurityQualityOfService: null }
      const status = (await invoke(createChild, [output, access, attrs, io, null, 0, 7, disposition,
        0x1 | (synchronous ? 0x20 : 0) | 0x00200000, null, 0])) >>> 0
      if (status !== 0) throw nativeError('NtCreateFile', status)
      const opened = output[0]
      if (opened === undefined || BigInt(opened) === 0n || BigInt(opened) === -1n) throw new Error('Windows directory open returned no handle')
      return opened
    }
    return {
      openRoot: async (path) => {
        const handle = await invoke(createRoot, [path, 0x001000a0, 7, null, 3, 0x02000000 | 0x00200000, 0])
        if (BigInt(handle) === -1n) throw new Error('Windows filesystem root could not be opened')
        return handle
      },
      child: async (parent, name, create) => {
        const encoded = Buffer.from(name, 'utf16le')
        if (encoded.length === 0 || encoded.length > MAX_UNICODE_BYTES || /[\u0000/\\]/.test(name) || name === '.' || name === '..') {
          throw new Error('Windows directory child must be one nonempty name')
        }
        if (create && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)
          || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
          || /[\u0000-\u001f]/.test(name))) {
          throw new Error('Windows directory child is not a valid Windows filename')
        }
        // Ancestors need traversal and attributes, not permission to list their contents.
        return open(parent, name, create ? 2 : 1, create ? 0 : 0x001000a0, !create)
      },
      reader: parent => open(parent, '.', 1, 0x00100081, true),
      identity: async (handle) => {
        const info = Buffer.alloc(52)
        if (await invoke(inspect, [handle, info]) === 0) throw new Error('Windows directory identity could not be read')
        const flags = info.readUInt32LE(0)
        if ((flags & 0x10) === 0 || (flags & 0x400) !== 0) throw new Error('Authorized directory parent is not a real directory')
        return { device: String(info.readUInt32LE(28)),
          inode: String(BigInt(info.readUInt32LE(44)) << 32n | BigInt(info.readUInt32LE(48))) }
      },
      read: async (handle) => {
        const buffer = Buffer.alloc(Math.ceil((filenameOffset + MAX_UNICODE_BYTES) / 8) * 8), io = Buffer.alloc(koffi.sizeof(statusBlock))
        const status = (await invoke(query, [handle, 0, null, null, io, buffer, buffer.length, 1, 0, null, 0])) >>> 0
        if (status === NO_MORE_FILES) return null
        if (status !== 0) throw nativeError('NtQueryDirectoryFile', status)
        const result = koffi.decode(io, statusBlock) as { Information: Handle }
        const bytes = Number(result.Information)
        if (!Number.isSafeInteger(bytes) || bytes < filenameOffset || bytes > buffer.length) throw new Error('Windows directory read returned an invalid byte count')
        const rows: PinnedDirectoryEntry[] = []
        for (let offset = 0;;) {
          if (offset + filenameOffset > bytes) throw new Error('Windows directory read returned a truncated entry')
          const next = buffer.readUInt32LE(offset), length = buffer.readUInt32LE(offset + koffi.offsetof(entry, 'FileNameLength'))
          if (length === 0 || length % 2 !== 0 || length > bytes - offset - filenameOffset
            || (next !== 0 && (next % 8 !== 0 || next < filenameOffset + length || next > bytes - offset))) {
            throw new Error('Windows directory read returned an invalid entry length')
          }
          const name = buffer.toString('utf16le', offset + filenameOffset, offset + filenameOffset + length)
          if (/[\u0000/\\]/.test(name)) throw new Error('Windows directory read returned an invalid entry name')
          const flags = buffer.readUInt32LE(offset + koffi.offsetof(entry, 'FileAttributes'))
          if (name !== '.' && name !== '..') rows.push({ name, isDirectory: (flags & 0x10) !== 0 && (flags & 0x400) === 0, isSymbolicLink: (flags & 0x400) !== 0 })
          if (next === 0) return rows
          offset += next
        }
      },
      close: async (handle) => { if (await invoke(release, [handle]) === 0) throw new Error('Windows directory handle could not close') },
      unload,
    }
  } catch (error) {
    try { unload() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Windows directory setup and cleanup failed') }
    throw error
  }
}
