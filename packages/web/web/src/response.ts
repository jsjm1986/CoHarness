/**
 * Bounded readers for JSON responses returned by web-search providers.
 * Provider implementations use this helper before parsing untrusted response
 * bodies; the web seam owns the byte-accounting mechanics while each provider
 * keeps its own error and payload vocabulary.
 * @module @deepseek-ai/dsh-web/response
 */

/** Default UTF-8 response-body budget for one web provider operation. */
export const DEFAULT_WEB_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
/** Hard upper bound for a configured web-provider response budget. */
export const MAX_WEB_RESPONSE_MAX_BYTES = 256 * 1024 * 1024

/** Raised when a provider response is larger than the caller's byte budget. */
export class WebResponseTooLargeError extends Error {
  /** @param limit - maximum accepted response bytes. */
  constructor(readonly limit: number) {
    super(`web provider response exceeds the ${String(limit)}-byte limit`)
    this.name = 'WebResponseTooLargeError'
  }
}

function tooLarge(limit: number): WebResponseTooLargeError {
  return new WebResponseTooLargeError(limit)
}

/**
 * Read a Fetch response without retaining more than `limit` bytes.
 * A declared `Content-Length` is rejected before reading; chunked and
 * under-declared responses are stopped as soon as the accumulated bytes cross
 * the same limit. The response stream is cancelled on an oversize result.
 *
 * @param response - response returned by the provider's fetch call.
 * @param limit - positive safe-integer UTF-8 byte budget.
 * @returns the complete response bytes.
 */
/* jscpd:ignore-start -- the web package keeps this stream guard beside its
   public reader; gateway-runtime owns a separate transport package. */
export async function readWebResponseBytes(
  response: Response,
  limit = DEFAULT_WEB_RESPONSE_MAX_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WEB_RESPONSE_MAX_BYTES) {
    throw new RangeError(`web response byte limit must be within 1..${String(MAX_WEB_RESPONSE_MAX_BYTES)}`)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      await Promise.resolve(response.body?.cancel()).catch(() => {})
      throw tooLarge(limit)
    }
  }

  // A standard Fetch Response exposes a stream for a non-empty body. The
  // null/undefined guard also keeps an empty or test-double response bounded.
  if (response.body == null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (!Number.isSafeInteger(total) || total > limit) {
        await reader.cancel().catch(() => {})
        throw tooLarge(limit)
      }
      chunks.push(next.value)
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
  return bytes
}
/* jscpd:ignore-end */

/**
 * Read and parse a bounded JSON response.
 *
 * @param response - response returned by the provider's fetch call.
 * @param limit - positive safe-integer UTF-8 byte budget.
 * @returns the decoded JSON value.
 */
export async function readWebResponseJson(
  response: Response,
  limit = DEFAULT_WEB_RESPONSE_MAX_BYTES,
): Promise<unknown> {
  // Fetch's concrete Response always has a stream. Keeping this narrow
  // fallback makes the helper preserve the observable error behavior of small
  // in-process Response-shaped test carriers without weakening real network
  // responses, whose body is read through the bounded path above.
  const headers = (response as unknown as { headers?: Headers }).headers
  if (response.body == null && headers === undefined) {
    const candidate = response as unknown as { json?: unknown }
    if (typeof candidate.json === 'function') return await (candidate.json as () => Promise<unknown>)()
  }
  const bytes = await readWebResponseBytes(response, limit)
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
