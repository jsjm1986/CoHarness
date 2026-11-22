/** Keep older browser shells from scheduling application preloads ahead of the Runtime bootstrap. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'

const MAX_BOOTSTRAP_BYTES = 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function preserveRequiredRows(body: Buffer): Buffer {
  let value: unknown
  try { value = JSON.parse(body.toString('utf8')) }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return body
  }
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'injections' || !Array.isArray(value.rows)) return body
  const rows = value.rows.filter((row: unknown) => !(isRecord(row) && row.kind === 'script-preload' && typeof row.src === 'string'))
  return rows.length === value.rows.length ? body : Buffer.from(JSON.stringify({ ...value, rows }))
}

async function* orderedBootstrap(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const pending: Buffer[] = []
  let length = 0
  for await (const chunk of source) {
    if (length <= MAX_BOOTSTRAP_BYTES) {
      length += chunk.length
      if (length <= MAX_BOOTSTRAP_BYTES) {
        pending.push(chunk)
        continue
      }
      yield* pending
      pending.length = 0
    }
    yield chunk
  }
  if (length <= MAX_BOOTSTRAP_BYTES) yield preserveRequiredRows(Buffer.concat(pending, length))
}

/** Send a structured index without speculative script hints to an already admitted browser.
 * Large, encoded and non-index responses retain their original bodies.
 * @param upstream - authenticated Runtime index response.
 * @param browser - Gateway response with its verified routing headers.
 * @returns completion of the owned response stream.
 */
export async function sendDeferredRuntimeBootstrap(upstream: IncomingMessage, browser: ServerResponse): Promise<void> {
  const status = upstream.statusCode ?? 502
  const headers = { ...upstream.headers }
  const mediaType = headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (status === 200 && mediaType === 'application/json'
    && (headers['content-encoding'] === undefined || headers['content-encoding'] === 'identity')) {
    delete headers['content-length']
    delete headers.etag
    browser.writeHead(status, headers)
    await pipeline(upstream, orderedBootstrap, browser)
  } else {
    browser.writeHead(status, headers)
    await pipeline(upstream, browser)
  }
}
