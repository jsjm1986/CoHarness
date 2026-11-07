/** Bounded JSON metadata followed by an independently owned raw document stream. */

/** A truncated, oversized or malformed document transport envelope. */
export class DocumentFrameError extends Error {
  /** @param message - bounded protocol diagnostic containing no payload bytes. */
  constructor(message: string) { super(message); this.name = 'DocumentFrameError' }
}

/** A failed stream operation whose owned cancellation also failed. */
export class DocumentStreamCleanupError extends AggregateError {
  /**
   * @param failure - original read or validation failure.
   * @param cleanupFailure - independently failed cancellation.
   */
  constructor(failure: unknown, readonly cleanupFailure: unknown) {
    super([failure, cleanupFailure], 'Document stream operation and cancellation failed.')
    this.name = 'DocumentStreamCleanupError'
  }
}

/**
 * Frame UTF-8 metadata without buffering its following document bytes.
 * @param metadata - JSON-serializable protocol metadata.
 * @param maxBytes - maximum encoded metadata bytes, excluding the fixed four-byte prefix.
 * @param body - raw bytes transferred to the returned stream; absent supplies an empty body.
 * @returns a stream whose cancellation joins cancellation of its raw source.
 */
export function documentFrame(metadata: unknown, maxBytes: number, body?: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const text: unknown = JSON.stringify(metadata)
  if (typeof text !== 'string') throw new DocumentFrameError('Document metadata is not JSON.')
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > maxBytes || bytes.byteLength > 0xffff_ffff) throw new DocumentFrameError('Document metadata exceeds its limit.')
  const prefix = new Uint8Array(4)
  new DataView(prefix.buffer).setUint32(0, bytes.byteLength)
  const reader = body?.getReader()
  let released = false
  const release = (): void => { if (reader !== undefined && !released) { released = true; reader.releaseLock() } }
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(prefix); controller.enqueue(bytes) },
    async pull(controller) {
      if (reader === undefined) { controller.close(); return }
      try {
        const next = await reader.read()
        if (next.done) { release(); controller.close() }
        else controller.enqueue(next.value)
      } catch (error) { release(); controller.error(error) }
    },
    async cancel(reason) {
      try { await reader?.cancel(reason) } finally { release() }
    },
  })
}

async function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read()
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller-owned AbortSignal.reason exactly.
    abort = () => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([reader.read(), interrupted]) } finally { signal.removeEventListener('abort', abort) }
}

/**
 * Read bounded metadata and transfer the remaining stream to its caller.
 * @param stream - one framed response or request, exclusively acquired until metadata is decoded.
 * @param maxBytes - metadata budget checked before allocating the declared payload.
 * @param signal - optional cancellation while opening metadata; ownership of returned bytes passes to the caller.
 * @returns parsed JSON, raw bytes and an idempotent source disposer; failures cancel and release the acquired reader.
 */
export async function readDocumentFrame(
  stream: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal,
): Promise<{ metadata: unknown; body: ReadableStream<Uint8Array>; discard(reason?: unknown): Promise<void> }> {
  const reader = stream.getReader()
  let chunk: Uint8Array = new Uint8Array(0), offset = 0, released = false
  const source = { failed: false }
  const release = (): void => { if (!released) { released = true; reader.releaseLock() } }
  const exact = async (length: number): Promise<Uint8Array> => {
    const result = new Uint8Array(length)
    let written = 0
    while (written < length) {
      if (offset === chunk.byteLength) {
        let next: ReadableStreamReadResult<Uint8Array>
        try { next = await nextChunk(reader, signal) } catch (error) {
          source.failed = signal?.aborted !== true || error !== signal.reason
          throw error
        }
        if (next.done) throw new DocumentFrameError('Document metadata is truncated.')
        chunk = next.value; offset = 0
        continue
      }
      const count = Math.min(length - written, chunk.byteLength - offset)
      result.set(chunk.subarray(offset, offset + count), written)
      offset += count; written += count
    }
    return result
  }
  try {
    const prefix = await exact(4)
    const length = new DataView(prefix.buffer).getUint32(0)
    if (length > maxBytes) throw new DocumentFrameError('Document metadata exceeds its limit.')
    const encoded = await exact(length)
    let metadata: unknown
    try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)) } catch {
      throw new DocumentFrameError('Document metadata is not UTF-8 JSON.')
    }
    let discarding: Promise<void> | undefined
    const discard = (reason?: unknown): Promise<void> => {
      if (discarding !== undefined) return discarding
      if (released) return Promise.resolve()
      const settled = Promise.withResolvers<void>()
      discarding = settled.promise
      void (async () => { try { await reader.cancel(reason) } finally { release() } })().then(settled.resolve, settled.reject)
      return discarding
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset < chunk.byteLength) { controller.enqueue(chunk.subarray(offset)); offset = chunk.byteLength; return }
        try {
          const next = await reader.read()
          if (next.done) { release(); controller.close() }
          else controller.enqueue(next.value)
        } catch (error) { release(); controller.error(error) }
      },
      cancel: discard,
    })
    return { metadata, body, discard }
  } catch (error) {
    if (!source.failed) {
      try { await reader.cancel(error) } catch (cleanupError) {
        throw new DocumentStreamCleanupError(error, cleanupError)
      } finally { release() }
    } else release()
    throw error
  }
}

/**
 * Settle a metadata-only body before acknowledging its operation.
 * @param body - raw remainder owned exclusively until EOF or cancellation.
 * @param signal - optional cancellation, including a read waiting for its next chunk.
 * @returns after EOF; unexpected bytes and interrupted reads cancel and release the source.
 */
export async function assertDocumentBodyEmpty(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader()
  const source = { failed: false }
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await nextChunk(reader, signal) } catch (error) {
        source.failed = signal?.aborted !== true || error !== signal.reason
        throw error
      }
      if (next.done) return
      if (next.value.byteLength !== 0) throw new DocumentFrameError('This document operation accepts no raw body.')
    }
  } catch (error) {
    if (!source.failed) {
      try { await reader.cancel(error) } catch (cleanupError) { throw new DocumentStreamCleanupError(error, cleanupError) }
    }
    throw error
  } finally { reader.releaseLock() }
}
