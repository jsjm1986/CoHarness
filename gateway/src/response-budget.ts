/** Bounded reads for responses received from runtime processes. */

/** Raised when an upstream response exceeds the Gateway's byte budget. */
export class ResponseBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`upstream response exceeds the ${String(limit)}-byte limit`)
    this.name = 'ResponseBodyTooLargeError'
  }
}

/** Read a Response body without retaining more than `limit` bytes. */
export async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('response byte limit must be a positive safe integer')
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) throw new ResponseBodyTooLargeError(limit)
    if (length > limit) {
      await Promise.resolve(response.body?.cancel()).catch(() => {})
      throw new ResponseBodyTooLargeError(limit)
    }
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        throw new ResponseBodyTooLargeError(limit)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

/** Read and parse bounded JSON; malformed JSON is reported as `undefined`. */
export async function readResponseJson(response: Response, limit: number): Promise<unknown> {
  const bytes = await readResponseBytes(response, limit)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return undefined
  }
}
