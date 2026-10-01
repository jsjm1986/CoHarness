/** Bounded runtime diagnostics with stream backpressure and one retained generation. */
import { mkdir, open, rename, stat, truncate, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'

/** Default per-file cap; the deployment tunes it via HGW_RUNTIME_LOG_CAP_BYTES. */
export const DEFAULT_RUNTIME_LOG_CAP_BYTES = 8 * 1024 * 1024

/**
 * Each file holds at most capBytes, including UTF-8 and oversized chunks.
 * Producers must honor Writable backpressure (or pipe into this stream).
 * Filesystem failure disables persistence, drains the producer, and reports
 * once to the supervisor; runtime execution does not depend on log storage.
 */
export class RuntimeLog extends Writable {
  private handle: FileHandle | undefined
  private bytes = 0
  private disabled = false
  private initialized = false
  private closing: Promise<void> | undefined
  private writing: Promise<void> | undefined

  constructor(private readonly path: string, private readonly capBytes: number) {
    super({ highWaterMark: Math.min(capBytes, 64 * 1024) })
    if (!Number.isSafeInteger(capBytes) || capBytes < 1) throw new RangeError('runtime log cap must be a positive safe integer')
  }

  private async openFile(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    if (!this.initialized) {
      try {
        if ((await stat(`${this.path}.1`)).size > this.capBytes) await truncate(`${this.path}.1`, this.capBytes)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      this.initialized = true
    }
    let existing = 0
    try { existing = (await stat(this.path)).size } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (existing >= this.capBytes) {
      // Bound files left by a larger previous configuration before retaining them.
      if (existing > this.capBytes) await truncate(this.path, this.capBytes)
      await rename(this.path, `${this.path}.1`)
      existing = 0
    }
    this.bytes = existing
    this.handle = await open(this.path, 'a', 0o600)
  }

  private async append(chunk: Buffer): Promise<void> {
    if (this.disabled) return
    try {
      let offset = 0
      while (offset < chunk.length && !this.disabled) {
        if (this.handle === undefined) await this.openFile()
        if (this.bytes === this.capBytes) {
          await this.handle!.close()
          this.handle = undefined
          await this.openFile()
        }
        if (this.disabled) return
        const length = Math.min(chunk.length - offset, this.capBytes - this.bytes)
        const { bytesWritten } = await this.handle!.write(chunk, offset, length)
        if (bytesWritten === 0) throw new Error('runtime log write made no progress')
        offset += bytesWritten
        this.bytes += bytesWritten
      }
    } catch {
      this.disabled = true
      console.error('[gateway] runtime log persistence disabled after a filesystem failure')
      await this.closeFile()
    }
  }

  private async closeFile(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    try { await handle?.close() } catch {
      // Diagnostic persistence is best-effort, including close after an I/O failure.
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const writing = this.append(chunk)
    this.writing = writing
    void writing.then(() => {
      this.writing = undefined
      callback()
    }, error => { this.writing = undefined; callback(error as Error) })
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.closeFile().then(() => callback(), error => callback(error as Error))
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.disabled = true
    void Promise.resolve(this.writing).then(() => this.closeFile()).then(() => callback(error), cause => callback(cause as Error))
  }

  /** Drain all admitted output and close the file; concurrent callers share settlement. */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closing = finished(this, { cleanup: true })
      this.end()
    }
    return this.closing
  }
}
