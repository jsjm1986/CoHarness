import { readFileSync, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import Negotiator from 'negotiator'

const gatewayRoot = resolve(import.meta.dirname, '..')

/** Default Vite `outDir` for the admin SPA. */
export const DEFAULT_ADMIN_ROOT = join(gatewayRoot, 'public/admin')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
}

function inside(rootReal: string, fileReal: string): boolean {
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  return fileReal === rootReal || fileReal.startsWith(prefix)
}

function gzipVariant(rootReal: string, fileReal: string): string | undefined {
  let variant: string
  try { variant = realpathSync(fileReal + '.gz') } catch { return undefined }
  return inside(rootReal, variant) && statSync(variant, { throwIfNoEntry: false })?.isFile() ? variant : undefined
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, cache: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': cache })
  res.end(body)
}

/**
 * True for `/admin` and `/admin/...` only. `/adminfoo` is not admin.
 * @param pathname - already-parsed URL pathname
 * @returns whether the path is the admin SPA or `/admin/api`
 */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

/**
 * Serves the admin SPA shell and `/admin/assets/*` from `root`, using build-time gzip variants when available.
 * @param req - GET/HEAD request and its accepted content codings
 * @param res - written on a hit (200 or 404)
 * @param pathname - already-parsed URL pathname
 * @param root - asset directory; default `gateway/public/admin`
 * @returns true when a response was written
 */
export function serveAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  root = DEFAULT_ADMIN_ROOT,
): boolean {
  if (!isAdminPath(pathname) || pathname.startsWith('/admin/api')) return false
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') return false

  let rootReal: string
  try { rootReal = realpathSync(root) } catch {
    return false
  }

  const spa = extname(pathname) === ''
  const rel = spa
    ? 'index.html'
    : pathname.startsWith('/admin/assets/')
      ? pathname.slice('/admin/'.length)
      : null
  if (rel === null) return false

  let fileReal: string
  try { fileReal = realpathSync(join(rootReal, rel)) } catch {
    if (spa) return false
    send(res, 404, 'not found', 'text/plain', 'no-store')
    return true
  }
  if (!inside(rootReal, fileReal)) {
    send(res, 404, 'not found', 'text/plain', 'no-store')
    return true
  }

  const ext = extname(fileReal)
  const type = TYPES[ext] ?? 'application/octet-stream'
  // The SPA shell must never be pinned: its hashed asset URLs change with
  // every release, and a cached shell would keep loading the old bundle.
  // Content-hashed files under assets/ are safe to cache for the client only —
  // `private` keeps the authenticated bundle out of shared caches.
  const cache = spa ? 'no-store' : 'private, max-age=31536000, immutable'
  const headers: OutgoingHttpHeaders = { 'content-type': type, 'cache-control': cache }
  let selectedFile = fileReal
  if (ext === '.js' || ext === '.css') {
    headers.vary = 'accept-encoding'
    const coding = req.headers['accept-encoding'] === undefined ? undefined : new Negotiator(req).encoding(['gzip', 'identity'])
    if (coding === 'gzip') {
      const variant = gzipVariant(rootReal, fileReal)
      if (variant !== undefined) {
        selectedFile = variant
        headers['content-encoding'] = 'gzip'
      }
    }
  }
  const body = method === 'HEAD' ? undefined : readFileSync(selectedFile)
  res.writeHead(200, headers)
  res.end(body)
  return true
}
