/** Lazy POSIX directory operations retaining opened objects across path replacement. */
import { getSystemErrorName } from 'node:util'
import { loadSystemBinding } from './binding.ts'

/** File-object identity captured by fstat on the owned directory descriptor. */
export interface DirectoryIdentity {
  /** Filesystem device identifier. */
  readonly device: bigint
  /** Directory inode identifier. */
  readonly inode: bigint
}

/** One directory entry copied before the next native read. */
export interface DirectoryEntry {
  /** Entry name within the opened directory. */
  readonly name: string
  /** The entry itself is a directory. */
  readonly isDirectory: boolean
  /** The entry itself is a symbolic link; its target has not been accessed. */
  readonly isSymbolicLink: boolean
}

interface NativeDirectory extends DirectoryIdentity {}
type Callback<T> = (errno: number, value: T) => void
interface DirectoryBinding {
  directoryOpen(path: string, callback: Callback<NativeDirectory>): void
  directoryOpenAt(parent: NativeDirectory, name: string, callback: Callback<NativeDirectory>): void
  directoryRead(parent: NativeDirectory, count: number, callback: Callback<DirectoryEntry[]>): void
  directoryMkdir(parent: NativeDirectory, name: string, callback: Callback<void>): void
  directoryClose(parent: NativeDirectory, callback: Callback<void>): void
  directoryVolume(parent: NativeDirectory, callback: Callback<string | undefined>): void
}

let binding: DirectoryBinding | undefined
function native(): DirectoryBinding {
  return binding ??= loadSystemBinding('directory') as DirectoryBinding
}

function call<T>(syscall: string, invoke: (callback: Callback<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((errno, value) => {
      if (errno === 0) { resolve(value); return }
      const code = getSystemErrorName(-errno)
      reject(Object.assign(new Error(`${code}: ${syscall} failed`), { code, errno, syscall }))
    })
  })
}

/**
 * An owned POSIX directory descriptor and its independent streaming reader.
 * Calls on one handle run serially. Closing queues behind outstanding work;
 * callers may stop awaiting without releasing resources that a worker still uses.
 */
export class DirectoryHandle {
  private tail: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined

  private constructor(private readonly handle: NativeDirectory) {}

  /** Identity of the directory actually opened, independent of its current path. */
  get identity(): DirectoryIdentity { return { device: this.handle.device, inode: this.handle.inode } }

  /**
   * Read the filesystem UUID from this owned directory descriptor on macOS.
   * Other platforms and volumes with a zero UUID return absence; syscall failures reject.
   * A volume UUID identifies a filesystem, not a directory or an authorization grant.
   * @returns the lowercase filesystem UUID, or absence where this primitive has no persistent volume identity.
   */
  volumeIdentity(): Promise<string | undefined> {
    return this.enqueue(() => call('fgetattrlist', callback => native().directoryVolume(this.handle, callback)))
  }

  /**
   * Open an absolute path without following a symbolic link in its final component.
   * Ancestor links are not excluded by this method; use a root handle and openChild
   * for every segment when authorization requires excluding ancestor replacement.
   * @param path - Absolute POSIX directory path.
   * @returns A handle the caller must close, or a rejected syscall/setup error.
   */
  static async open(path: string): Promise<DirectoryHandle> {
    return new DirectoryHandle(await call('open', callback => native().directoryOpen(path, callback)))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) return Promise.reject(Object.assign(new Error('Directory is closed'), { code: 'EBADF' }))
    const pending = this.tail.then(operation)
    // Queue completion must not retain a child handle returned by openChild.
    this.tail = pending.then(() => undefined, () => undefined)
    return pending
  }

  /**
   * Open one real child directory relative to this retained descriptor.
   * @param name - One nonempty name other than dot or dot-dot; links are refused.
   * @returns An independently owned child handle, unaffected by parent path replacement.
   */
  openChild(name: string): Promise<DirectoryHandle> {
    return this.enqueue(async () => new DirectoryHandle(await call('openat', callback => native().directoryOpenAt(this.handle, name, callback))))
  }

  /**
   * Read the next bounded batch without following entry links.
   * @param count - Integer from 1 to 65,536; the native allocation bound.
   * @returns At most count entries, or an empty batch at end of directory.
   */
  read(count: number): Promise<DirectoryEntry[]> {
    return this.enqueue(() => call('readdir', callback => native().directoryRead(this.handle, count, callback)))
  }

  /**
   * Create a directory relative to this retained descriptor using 0777 and umask.
   * @param name - One nonempty name other than dot or dot-dot.
   * @returns Completion after mkdirat, rejecting existing entries and syscall failures.
   */
  createDirectory(name: string): Promise<void> {
    return this.enqueue(() => call('mkdirat', callback => native().directoryMkdir(this.handle, name, callback)))
  }

  /**
   * Close the reader and descriptor after all previously queued calls settle.
   * @returns The same close promise on repeated calls; subsequent work rejects.
   */
  close(): Promise<void> {
    return this.closing ??= this.tail.then(() => call('close', callback => native().directoryClose(this.handle, callback)))
  }
}
