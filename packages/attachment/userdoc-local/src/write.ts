/** Complete document writes before publication or durable upload acknowledgement. */
import type { FileHandle } from 'node:fs/promises'

/**
 * Persist every byte, retrying partial syscalls without advancing acknowledged progress.
 * @param handle - open writable file owned by the caller.
 * @param data - bytes that remain stable until the write finishes.
 * @param position - absolute offset, or null to advance the handle's current position.
 * @param signal - cancellation checked between writes and before success.
 * @returns after all bytes are written; the caller still owns sync and close.
 */
export async function writeAll(handle: FileHandle, data: Uint8Array, position: number | null, signal?: AbortSignal): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    signal?.throwIfAborted()
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, position === null ? null : position + offset)
    if (bytesWritten === 0) throw new Error('The document write made no progress.')
    offset += bytesWritten
  }
  signal?.throwIfAborted()
}
