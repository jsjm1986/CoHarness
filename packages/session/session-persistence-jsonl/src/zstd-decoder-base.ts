/**
 * Shared single-use lifecycle for the interchangeable synchronous frame
 * decoders: a decoder starts once, decodes, and closes.
 * @module dsh-session-persistence-jsonl/zstd-decoder-base
 */

import type { ZstdFrameDecoder, ZstdFrameRange } from './zstd.ts'

/**
 * Base lifecycle state shared by the private-handle and public-API frame
 * decoders. Subclasses supply the per-frame decode operation and may release
 * additional resources in an overridden {@link ZstdFrameDecoderBase.close}.
 */
export abstract class ZstdFrameDecoderBase implements ZstdFrameDecoder {
  private started = false
  protected closed = false

  /**
   * Reject a second decode or a decode on a closed instance, then mark the
   * decoder started.
   */
  protected assertStartable(): void {
    if (this.started) throw new Error('Zstandard frame decoder was already started')
    if (this.closed) throw new Error('cannot start a closed Zstandard frame decoder')
    this.started = true
  }

  /** @inheritdoc */
  abstract decode(
    source: Buffer,
    frames: readonly ZstdFrameRange[],
    maxOutputBytes?: number,
  ): Generator<Buffer, void, void>

  /** @inheritdoc */
  close(): void {
    this.closed = true
  }
}
