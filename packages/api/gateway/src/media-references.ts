/**
 * Authenticated GET/HEAD `/api/file` reads bounded file responses through
 * the composed filesystem provider. Paths and MIME types do not restrict
 * access; Connection's `/api` route applies the Host/Origin fence and the
 * browser-session cookie before this subtree's handler runs.
 * @module @deepseek-ai/dsh-api-gateway/media-references
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
import mime from 'mime-types'

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

const FS_STATUSES: Partial<Record<FsError['code'], number>> = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_TOO_LARGE: 413,
  FS_ABORTED: 499,
}

async function serveFile(req: IncomingMessage, res: ServerResponse, fs: FileSystem, maxBytes: number): Promise<void> {
  const head = req.method === 'HEAD'
  const fail = (status: number, text: string): void => {
    res.writeHead(status, BASE_HEADERS)
    res.end(head ? undefined : text)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(405, 'method not allowed')
    return
  }
  const path = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('path')
  if (path === null || path.length === 0) {
    fail(400, 'missing path')
    return
  }
  if (path.includes('\0') || !isAbsolute(path)) {
    fail(400, 'absolute path required')
    return
  }
  const abort = new AbortController()
  // A keep-alive socket outlives one request, so socket close is the only
  // reliable client-disconnect signal for an in-flight bounded read.
  req.socket.once('close', () => { abort.abort() })
  try {
    const target = await fs.resolve(path, { signal: abort.signal })
    const mediaType = mime.lookup(target.displayPath) || 'application/octet-stream'
    const headers: Record<string, string> = { ...BASE_HEADERS, 'Content-Type': mediaType }
    if (head) {
      const info = await fs.stat(target, abort.signal)
      if (info === undefined) {
        fail(404, 'not found')
        return
      }
      if (info.type !== 'file') {
        fail(403, 'not a regular file')
        return
      }
      if (info.size !== undefined) {
        if (info.size > maxBytes) {
          fail(413, 'file exceeds byte limit')
          return
        }
        headers['Content-Length'] = String(info.size)
      }
      res.writeHead(200, headers)
      res.end()
      return
    }
    const bytes = await fs.readBytes(target, abort.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    res.writeHead(200, headers)
    res.end(bytes.slice())
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    fail(FS_STATUSES[error.code] ?? 500, error.code)
  }
}

/**
 * File-display contribution mounted when the host composes Connection and a
 * filesystem provider. The route serves any file `ctx.fs` can read, bounded
 * by the attachment service's image byte limit.
 * @param ctx - host context carrying the connection, fs, and attachments services.
 * @returns the route fiber; it resolves once Connection, fs, and attachments are active.
 */
export function registerMediaReferences(ctx: Context) {
  return ctx.inject(['connection', 'fs', 'attachments'], (routeCtx) => {
    const maxBytes = routeCtx.attachments.imageLimits.maxImageBytes
    routeCtx.effect(() => routeCtx.connection.http.handlePrefix(
      '/api/file',
      (req, res) => serveFile(req, res, routeCtx.fs, maxBytes),
      { authority: 'trusted-host' },
    ), 'api-gateway: /api/file')
  })
}
