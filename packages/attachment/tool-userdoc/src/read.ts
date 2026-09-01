/** Bounded byte reading for the model-facing personal-document tool. */

import { TextDecoder } from 'node:util'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { UserDocRef } from '@deepseek-ai/dsh-userdoc'

/** Result of consuming a bounded document stream. */
export interface BoundedDocumentBytes {
  readonly bytes: Uint8Array
  readonly truncated: boolean
}

/** Stable failure code for a document that is not strict UTF-8 text. */
export const USERDOC_NOT_TEXT_CODE = 'USERDOC_NOT_TEXT' as const

/** Error raised when a document cannot be represented as strict UTF-8 text. */
export class PersonalDocumentTextError extends HarnessError {
  override readonly code = USERDOC_NOT_TEXT_CODE

  /**
   * @param _ref - metadata for the unreadable document, retained for the typed call site.
   * @param options - optional chained cause.
   */
  constructor(_ref: Pick<UserDocRef, 'name' | 'mediaType'>, options?: ErrorOptions) {
    super(
      'personal document is not a UTF-8 text file; use a format-specific document reader',
      USERDOC_NOT_TEXT_CODE,
      options,
    )
  }
}

/**
 * Read at most `maxBytes` from a document body and cancel the rest.
 * @param body - document byte stream.
 * @param maxBytes - maximum bytes to retain.
 * @param signal - cancellation signal owned by the tool execution.
 * @returns retained bytes and whether the stream exceeded the cap.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BoundedDocumentBytes> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      const next = await readWithAbort(reader, signal)
      if (next.done) break
      const chunk = next.value
      const remaining = maxBytes - total
      if (remaining <= 0) {
        truncated = true
        await cancelReader(reader)
        break
      }
      if (chunk.byteLength > remaining) {
        // Copy the retained prefix so a provider's oversized backing buffer is
        // not kept alive by the bounded result.
        chunks.push(chunk.slice(0, remaining))
        total += remaining
        truncated = true
        await cancelReader(reader)
        break
      }
      chunks.push(chunk)
      total += chunk.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

/** Cancel a provider reader without replacing the result with a close race. */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // The provider may have closed or failed the stream already; the caller is
    // abandoning the remainder and has no useful recovery action here.
  }
}

/** Return the encoded length for a valid UTF-8 lead byte, or zero otherwise. */
function utf8SequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 0
}

/** Return whether a byte suffix is a structurally valid but incomplete UTF-8 code point. */
function isIncompleteUtf8Suffix(bytes: Uint8Array, start: number): boolean {
  const length = bytes.length - start
  const lead = bytes[start] as number
  const expected = utf8SequenceLength(lead)
  if (expected === 0 || length >= expected) return false
  // Complete the candidate with continuation bytes and let the platform's
  // strict decoder enforce continuation, overlong, surrogate, and range rules.
  const completed = new Uint8Array(expected)
  completed.set(bytes.subarray(start))
  completed.fill(0x80, length)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(completed)
    return true
  } catch {
    return false
  }
}

/**
 * Decode a bounded prefix while trimming only an incomplete trailing code point.
 * @param value - retained bytes and truncation state.
 * @param ref - document metadata for an unreadable-file error.
 * @returns decoded text and its truncation state.
 */
export function decodeDocumentText(
  value: BoundedDocumentBytes,
  ref: Pick<UserDocRef, 'name' | 'mediaType'>,
): { text: string; truncatedBytes: boolean } {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return { text: decoder.decode(value.bytes), truncatedBytes: value.truncated }
  } catch (error) {
    if (!value.truncated) throw new PersonalDocumentTextError(ref)
    // A bounded prefix may end in the middle of a UTF-8 code point. Remove at
    // most three trailing bytes and retry, but only when the removed suffix is
    // structurally an incomplete code point; an invalid byte is never hidden.
    const minimum = Math.max(0, value.bytes.byteLength - 3)
    for (let end = value.bytes.byteLength - 1; end >= minimum; end -= 1) {
      if (!isIncompleteUtf8Suffix(value.bytes, end)) continue
      try {
        return {
          text: decoder.decode(value.bytes.subarray(0, end)),
          truncatedBytes: true,
        }
      } catch {
        // Continue until the cut reaches a valid UTF-8 boundary.
      }
    }
    throw new PersonalDocumentTextError(ref, { cause: error })
  }
}

/** Read one stream chunk while preserving cancellation when the reader ignores it. */
/* jscpd:ignore-start -- document bodies have an independent cancellation boundary. */
async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    await cancelReader(reader)
    throw cancellationError(signal)
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = (): void => {
      finish(() => {
        // Wait for the provider's cancellation to settle before releasing the
        // reader lock, so an aborted tool leaves no in-flight body operation.
        void cancelReader(reader).then(() => { reject(cancellationError(signal)) })
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      (value) => { finish(() => { resolve(value) }) },
      (error: unknown) => { finish(() => { reject(error instanceof Error ? error : new Error(String(error), { cause: error })) }) },
    )
  })
}
/* jscpd:ignore-end */

/** Convert an arbitrary AbortSignal reason to the Error expected by callers. */
function cancellationError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error('personal document read was cancelled', { cause: signal.reason })
}
