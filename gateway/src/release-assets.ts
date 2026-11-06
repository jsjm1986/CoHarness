/**
 * Center-local release static assets: the built web frontend dist is an
 * immutable release payload with identical bytes on every computer running
 * the same release, so the center answers byte-deterministic `/assets/*` and
 * `/favicon.svg` requests from its own copy instead of pinning one Runtime
 * (302) and proxying through the owning node — a remote hop that re-sends
 * multi-megabyte bundles over the slowest link and re-keys the browser cache
 * per Runtime. Runtime-installed plugin bundles, synthesized `/plugins`
 * responses, and the live `/plugins/events` channel stay on the runtime path.
 */
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const brotli = promisify(brotliCompress)
const deflate = promisify(gzip)

/**
 * Served byte types. Mirrors `MIME` in `packages/host/frontend-static`, which
 * answers the same dist files on the runtime path — keep the tables aligned so
 * a given URL reports one media type whichever side serves it.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Vite emits `name-<8+ char content hash>.<ext>` under `assets/`, including
 * nested `assets/langs/` and `assets/fonts/` directories; the basename check
 * generalizes the top-level `IMMUTABLE_ASSET_PATH` used by the runtime.
 */
const CONTENT_HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[^/\\]+$/u

/** Cache policy for content-addressed files: the authenticated bundle stays out of shared caches. */
const IMMUTABLE_PRIVATE = 'private, max-age=31536000, immutable'

/** Content codings the center can serve, mirroring `precompressed.ts` in `packages/host/webserver`. */
type Coding = 'br' | 'gzip'

/**
 * Variant quality levels mirror `precompressed.ts` in `packages/host/webserver`
 * so a file served by either side carries the same codings.
 */
const BROTLI_QUALITY = 9
const GZIP_LEVEL = 1

/** Cached encoding variants for one file generation (mtime+size identity). */
interface EncodedBody {
  /** File signature the variants were built from; a changed file gets a fresh entry. */
  stamp: { mtimeMs: number; size: number }
  /**
   * Per-coding compressed bodies. Entries appear only after their compression
   * settled — a request arriving earlier falls back to a ready coding or
   * identity, mirroring `precompressed.ts` in `packages/host/webserver`.
   */
  variants: Map<Coding, Promise<Buffer>>
  /** Whether background compression was kicked off for this generation. */
  scheduled: boolean
}

/**
 * Accepted `br`/`gzip` codings with `q>0`; `*` expands to both. Preference
 * order is fixed ({@link Coding} order), matching `selectVariant`.
 * @param header - the request's `accept-encoding` header value.
 * @returns the supported codings the client advertised.
 */
function acceptedCodings(header: string | string[] | undefined): Set<Coding> {
  const accepted = new Set<Coding>()
  for (const item of (Array.isArray(header) ? header.join(',') : header ?? '').split(',')) {
    const [name = '', ...params] = item.split(';')
    const coding = name.trim().toLowerCase()
    if (coding !== 'br' && coding !== 'gzip' && coding !== '*') continue
    let q = 1
    for (const param of params) {
      const [key = '', value] = param.split('=', 2)
      if (key.trim().toLowerCase() === 'q') q = Number(value)
    }
    if (!(q > 0)) continue
    if (coding === '*') { accepted.add('br'); accepted.add('gzip') } else accepted.add(coding)
  }
  return accepted
}

/**
 * The release frontend dist, when this deployment carries a built one.
 * Managed releases and workspace checkouts keep it at `apps/web/dist`; a
 * pinned CLI install resolves through the runtime's own dependency chain
 * (`dsh` → `dsh-web-app` → `dsh-web-frontend`), so the center reads the exact
 * files the runtime's `frontend-static` would serve. `index.html` is the
 * payload marker `validate_release` requires.
 * @param cfg - repository root and spawn command of the runtime entry.
 * @returns the dist directory, or undefined for a deployment without the frontend payload.
 */
export function releaseAssetRoot(cfg: { dshRepoRoot: string; dshCommand: readonly string[] }): string | undefined {
  const builtDist = (dist: string): string | undefined => {
    try {
      return statSync(join(dist, 'index.html')).isFile() ? dist : undefined
    } catch {
      return undefined
    }
  }
  const direct = builtDist(join(cfg.dshRepoRoot, 'apps/web', 'dist'))
  if (direct !== undefined) return direct
  const script = cfg.dshCommand.find(arg => isAbsolute(arg) && /[\\/]bin\.[cm]?[jt]s$/u.test(arg))
  if (script === undefined) return undefined
  try {
    const webApp = createRequire(script).resolve('@deepseek-ai/dsh-web-app/package.json')
    const frontend = createRequire(webApp).resolve('@deepseek-ai/dsh-web-frontend/package.json')
    return builtDist(join(dirname(frontend), 'dist'))
  } catch {
    return undefined
  }
}

/**
 * Serves one release's frontend dist at the center. Compression variants are
 * scheduled once per file generation on the first `GET`, held in memory, and
 * rebuilt when the file's mtime or size changes.
 */
export class ReleaseAssets {
  private readonly bodies = new Map<string, EncodedBody>()
  /** Canonical absolute dist root; request targets must stay inside it. */
  readonly root: string

  /**
   * @param root - absolute path of the release `dist` directory; the
   * constructor does not require it to exist so a missing payload degrades to
   * per-request misses (the runtime path answers instead).
   */
  constructor(root: string) {
    this.root = resolve(root)
  }

  /**
   * Open the configured release dist, if any.
   * @param cfg - repository root and spawn command of the runtime entry.
   * @returns a server for the release dist, or undefined when this deployment carries no built frontend.
   */
  static forConfig(cfg: { dshRepoRoot: string; dshCommand: readonly string[] }): ReleaseAssets | undefined {
    const root = releaseAssetRoot(cfg)
    return root === undefined ? undefined : new ReleaseAssets(root)
  }

  private schedule(target: string, entry: EncodedBody, coding: Coding, produce: Promise<Buffer>): void {
    void produce.then(
      compressed => { entry.variants.set(coding, Promise.resolve(compressed)) },
      (error: unknown) => {
        // Encoding failure is not a request failure: the identity bytes remain served.
        console.error(`[gateway] release asset ${coding} encoding failed for ${target}:`, error)
      },
    )
  }

  /**
   * Answer one GET/HEAD request for a file under the dist root.
   * @param req - the authenticated browser request; only `accept-encoding` is read.
   * @param res - written on a served hit.
   * @param pathname - already-parsed (still percent-encoded) URL pathname.
   * @returns true when a response was written; false for non-GET/HEAD, a
   * malformed or escaping path, or a file absent from this release — the
   * caller then leaves the request on the normal runtime path.
   */
  async serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') return false
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return false
    }
    const target = resolve(normalize(join(this.root, decoded)))
    if (!target.startsWith(this.root + sep)) return false
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(target)
    } catch {
      return false
    }
    if (!stat.isFile()) return false
    const headers: Record<string, string> = {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      vary: 'accept-encoding',
      ...(CONTENT_HASHED_NAME.test(basename(target)) ? { 'cache-control': IMMUTABLE_PRIVATE } : {}),
    }
    if (method === 'HEAD') {
      // A HEAD reports the coding a GET would serve now: a settled variant only.
      const settled = this.bodies.get(target)?.variants
      const coding = (['br', 'gzip'] as const)
        .find(candidate => acceptedCodings(req.headers['accept-encoding']).has(candidate) && settled?.has(candidate) === true)
      res.writeHead(200, { ...headers, ...(coding === undefined ? {} : { 'content-encoding': coding }) })
      res.end()
      return true
    }
    const stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    let entry = this.bodies.get(target)
    if (entry === undefined || entry.stamp.mtimeMs !== stamp.mtimeMs || entry.stamp.size !== stamp.size) {
      entry = { stamp, variants: new Map(), scheduled: false }
      this.bodies.set(target, entry)
    }
    let body: Buffer
    try {
      body = await readFile(target)
    } catch {
      // The file vanished between stat and read; the runtime path owns the answer.
      return false
    }
    if (!entry.scheduled) {
      entry.scheduled = true
      this.schedule(target, entry, 'br', brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }))
      this.schedule(target, entry, 'gzip', deflate(body, { level: GZIP_LEVEL }))
    }
    const accepted = acceptedCodings(req.headers['accept-encoding'])
    for (const coding of ['br', 'gzip'] as const) {
      if (!accepted.has(coding)) continue
      const variant = entry.variants.get(coding)
      if (variant === undefined) continue
      try {
        const encoded = await variant
        res.writeHead(200, { ...headers, 'content-encoding': coding })
        res.end(encoded)
      } catch {
        // A failed variant leaves the entry's other codings and identity.
        res.writeHead(200, headers)
        res.end(body)
      }
      return true
    }
    res.writeHead(200, headers)
    res.end(body)
    return true
  }
}
