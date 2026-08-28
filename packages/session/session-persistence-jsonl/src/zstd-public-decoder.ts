/**
 * Public-API synchronous Zstandard frame decoder fallback.
 * @module dsh-session-persistence-jsonl/zstd-public-decoder
 */

import { zstdDecompressSync } from 'node:zlib'
import type { ZstdFrameDecoder, ZstdFrameRange } from './zstd.ts'
import { ZstdOutputLimitError } from './zstd-errors.ts'

/** Multi-frame adapter built exclusively from Node's supported one-shot API. */
export class PublicZstdFrameDecoder implements ZstdFrameDecoder {
  private started = false
  private closed = false

  /** @inheritdoc */
  public *decode(
    source: Buffer,
    frames: readonly ZstdFrameRange[],
    maxOutputBytes?: number,
  ): Generator<Buffer, void, void> {
    if (this.started) throw new Error('Zstandard frame decoder was already started')
    if (this.closed) throw new Error('cannot start a closed Zstandard frame decoder')
    this.started = true
    try {
      let totalOutputBytes = 0
      for (const { start, end } of frames) {
        let decoded: Buffer
        try {
          const remaining = maxOutputBytes === undefined ? undefined : maxOutputBytes - totalOutputBytes
          if (remaining !== undefined && remaining < 1) throw new ZstdOutputLimitError(maxOutputBytes ?? 0)
          decoded = zstdDecompressSync(
            source.subarray(start, end),
            remaining === undefined ? undefined : { maxOutputLength: remaining },
          )
        } catch (error) {
          if (error instanceof ZstdOutputLimitError) throw error
          if (maxOutputBytes !== undefined
            && error instanceof Error
            && 'code' in error
            && (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
            throw new ZstdOutputLimitError(maxOutputBytes)
          }
          throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, {
            cause: error,
          })
        }
        totalOutputBytes += decoded.length
        yield decoded
      }
    } finally {
      this.close()
    }
  }

  /** @inheritdoc */
  close(): void {
    this.closed = true
  }
}
