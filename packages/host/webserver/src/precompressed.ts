/**
 * Precompressed variants for immutable response bodies. Compression runs once
 * per body on Node's libuv thread pool after the first read — never per
 * request — and a request arriving before its variant settles falls back to a
 * ready coding or identity. Owners set `content-encoding` plus
 * `vary: accept-encoding` themselves; a body already carrying
 * `content-encoding` is skipped by the gzip middleware, so the two
 * compression paths cannot stack.
 * @module precompressed.ts
 */

import { brotliCompress, constants, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import Negotiator from 'negotiator'

const brotli = promisify(brotliCompress)
const deflate = promisify(gzip)

/** Content codings a {@link PrecompressedBody} can serve. */
export type PrecompressedCoding = 'br' | 'gzip'

/**
 * Largest Brotli quality whose background cost stays in the gzip ballpark:
 * quality 9 compresses an 11.5 MB script in ~0.3s where quality 10 takes ~4s.
 */
const BROTLI_QUALITY = 9
/** Matches the compression middleware's default level. */
const GZIP_LEVEL = 1

/**
 * An immutable response body plus its background-compressed variants.
 * Variant promises exist only after their compression completed; a rejected
 * variant is dropped so every request sees a settled coding or identity.
 */
export interface PrecompressedBody {
  /**
   * Read the uncompressed body; the first call also schedules the variants.
   * @returns the body's identity bytes (shared settlement across callers).
   */
  identity(): Promise<Buffer>
  /**
   * @param coding - candidate content coding.
   * @returns the settled compressed body, or undefined while compression is
   * still running or has failed.
   */
  variant(coding: PrecompressedCoding): Promise<Buffer> | undefined
}

/**
 * Wrap one lazy immutable body with background Brotli and gzip variants.
 * @param identity - produces the body's bytes once (shared settlement).
 * @param onError - reports a failed variant; the variant is then dropped and
 * requests keep seeing the remaining codings or identity.
 * @returns the identity/variant view consumed by the serving path.
 */
export function precompressBody(
  identity: () => Promise<Buffer>,
  onError: (error: unknown) => void,
): PrecompressedBody {
  let identityBody: Promise<Buffer> | undefined
  const variants = new Map<PrecompressedCoding, Promise<Buffer>>()
  const ensure = (): Promise<Buffer> => {
    if (identityBody !== undefined) return identityBody
    const body = identityBody = identity()
    const schedule = (coding: PrecompressedCoding, compress: (bytes: Buffer) => Promise<Buffer>): void => {
      void body.then(bytes => compress(bytes).then((compressed) => {
        variants.set(coding, Promise.resolve(compressed))
      }, (error: unknown) => {
        onError(error)
      }), () => {
        // Identity rejections reach identity() callers; variants just stay unsettled.
      })
    }
    schedule('br', bytes => brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }))
    schedule('gzip', bytes => deflate(bytes, { level: GZIP_LEVEL }))
    return body
  }
  return {
    identity: ensure,
    variant: coding => identityBody === undefined ? undefined : variants.get(coding),
  }
}

/**
 * Accept-Encoding codings the client advertised, in client preference order,
 * restricted to the codings a {@link PrecompressedBody} can serve.
 * @param acceptEncoding - the request's `accept-encoding` header value.
 * @returns supported codings best-first (empty: serve identity).
 */
export function acceptableEncodings(acceptEncoding: string | string[] | undefined): PrecompressedCoding[] {
  if (acceptEncoding === undefined) return []
  const value = Array.isArray(acceptEncoding) ? acceptEncoding.join(', ') : acceptEncoding
  return new Negotiator({ headers: { 'accept-encoding': value } }).encodings(['br', 'gzip']) as PrecompressedCoding[]
}

/**
 * Pick the best settled variant for one request's Accept-Encoding header.
 * The server prefers Brotli over gzip among the codings the client accepted
 * (a `q=0` exclusion is honored; quality ordering is not), and a preferred
 * coding still compressing falls through to a ready one or identity.
 * @param body - the immutable body and its background variants.
 * @param acceptEncoding - the request's `accept-encoding` header value.
 * @returns the ready { coding, body } best matching the client's acceptance,
 * or undefined when no advertised variant has settled (serve identity).
 */
export function selectVariant(
  body: PrecompressedBody,
  acceptEncoding: string | string[] | undefined,
): { coding: PrecompressedCoding; body: Promise<Buffer> } | undefined {
  const accepted = new Set(acceptableEncodings(acceptEncoding))
  for (const coding of ['br', 'gzip'] as const) {
    if (!accepted.has(coding)) continue
    const variant = body.variant(coding)
    if (variant !== undefined) return { coding, body: variant }
  }
  return undefined
}
