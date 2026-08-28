/** Errors raised by bounded Zstandard decoding. */

/** A compressed frame produced more plaintext than the configured budget. */
export class ZstdOutputLimitError extends Error {
  /**
   * @param maxBytes - maximum plaintext bytes accepted by the decoder.
   */
  constructor(readonly maxBytes: number) {
    super(`Zstandard decompressed output exceeds ${maxBytes} bytes`)
    this.name = 'ZstdOutputLimitError'
  }
}
