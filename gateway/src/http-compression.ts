/** Dynamic HTTP response compression for Gateway JSON and HTML payloads. */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const brotli = promisify(brotliCompress)
const deflate = promisify(gzip)

/** Content codings dynamically applied to compressible Gateway responses. */
export type ContentCoding = 'br' | 'gzip'

/** Minimum byte length worth compressing; smaller responses stay identity-encoded. */
export const MIN_COMPRESS_BYTES = 1024

const BROTLI_QUALITY = 4
const GZIP_LEVEL = 4

const COMPRESSIBLE_MEDIA_TYPES = new Set([
  'application/json',
  'text/html',
  'text/javascript',
  'application/javascript',
  'text/css',
  'image/svg+xml',
  'text/plain',
])

/**
 * Select the highest-priority supported compression coding accepted by the client.
 * Ties prefer Brotli over gzip; zero quality excludes a coding.
 * @param header - incoming `accept-encoding` header value.
 * @returns `'br'`, `'gzip'`, or `undefined` when identity transfer is required.
 */
export function preferredCompression(header: string | string[] | undefined): ContentCoding | undefined {
  if (header === undefined) return undefined
  const raw = Array.isArray(header) ? header.join(',') : header
  if (raw.trim() === '') return undefined
  const explicit = new Map<ContentCoding, number>()
  let wildcard: number | undefined
  for (const item of raw.split(',')) {
    const [name = '', ...params] = item.split(';')
    const coding = name.trim().toLowerCase()
    if (coding !== 'br' && coding !== 'gzip' && coding !== '*') continue
    let q = 1
    let valid = true
    for (const param of params) {
      const eq = param.indexOf('=')
      if (eq < 0) continue
      const key = param.slice(0, eq).trim().toLowerCase()
      if (key !== 'q') continue
      const parsed = Number(param.slice(eq + 1).trim())
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) { valid = false; break }
      q = parsed
    }
    if (!valid) continue
    if (coding === '*') wildcard = wildcard === undefined ? q : Math.max(wildcard, q)
    else explicit.set(coding, explicit.has(coding) ? Math.max(explicit.get(coding)!, q) : q)
  }
  const brQ = explicit.has('br') ? explicit.get('br')! : (wildcard ?? 0)
  const gzipQ = explicit.has('gzip') ? explicit.get('gzip')! : (wildcard ?? 0)
  if (brQ <= 0 && gzipQ <= 0) return undefined
  return brQ >= gzipQ ? 'br' : 'gzip'
}

/**
 * Check whether a `content-type` header represents compressible non-streaming text or JSON.
 * @param contentType - MIME type with optional parameters (for example `; charset=utf-8`).
 * @returns true when dynamic compression is safe for this media type.
 */
export function isCompressibleContentType(contentType: string): boolean {
  const semi = contentType.indexOf(';')
  const base = (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
  return COMPRESSIBLE_MEDIA_TYPES.has(base)
}

/**
 * Compress a byte buffer with fast interactive-latency settings.
 * @param raw - uncompressed UTF-8 or binary bytes.
 * @param coding - negotiated content coding.
 * @returns compressed buffer.
 */
export function compressBuffer(raw: Buffer, coding: ContentCoding): Promise<Buffer> {
  return coding === 'br'
    ? brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
    : deflate(raw, { level: GZIP_LEVEL })
}

/**
 * Append one header name to a response's `vary` header without clobbering existing tokens.
 * @param res - response whose `vary` header is updated prior to `writeHead`.
 * @param token - header name to include (for example `'accept-encoding'`).
 */
export function appendVary(res: ServerResponse, token: string): void {
  const existing = res.getHeader('vary')
  const values = (Array.isArray(existing) ? existing.join(',') : typeof existing === 'string' ? existing : '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
  if (values.some(part => part.toLowerCase() === token.toLowerCase())) return
  values.push(token)
  res.setHeader('vary', values.join(', '))
}

/**
 * Write a complete buffered HTTP response, applying Brotli or gzip when negotiated and beneficial.
 * Preserves any headers already staged on `res` (including `cache-control`, `set-cookie`, and `vary`).
 * @param req - incoming browser or peer request (`accept-encoding` and `method` are inspected).
 * @param res - destination response.
 * @param status - HTTP status code.
 * @param body - complete uncompressed response body.
 * @param contentType - response `content-type` header value.
 * @param extraHeaders - optional additional headers merged into `writeHead`.
 */
export async function sendCompressed(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
  extraHeaders?: OutgoingHttpHeaders,
): Promise<void> {
  if (res.destroyed || res.writableEnded) return
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const compressible = isCompressibleContentType(contentType)
    && res.getHeader('content-encoding') === undefined
    && raw.byteLength >= MIN_COMPRESS_BYTES
  let payload = raw
  let encoding: ContentCoding | undefined
  if (compressible) {
    appendVary(res, 'accept-encoding')
    const coding = preferredCompression(req.headers['accept-encoding'])
    if (coding !== undefined) {
      const compressed = await compressBuffer(raw, coding)
      if (res.destroyed || res.writableEnded) return
      if (compressed.byteLength < raw.byteLength) {
        payload = compressed
        encoding = coding
      }
    }
  }
  const headers: OutgoingHttpHeaders = {
    ...extraHeaders,
    'content-type': contentType,
    'content-length': payload.byteLength,
    ...(encoding === undefined ? {} : { 'content-encoding': encoding }),
  }
  res.writeHead(status, headers)
  if (req.method === 'HEAD') res.end()
  else res.end(payload)
}
