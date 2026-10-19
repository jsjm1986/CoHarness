/** Fetch-shaped adapter driving Connection's streaming HTTP prefix registry in tests. */

import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection'

/**
 * Minimal Node request/response pair exposing the surface {@link HostConnectionService.dispatchHttp} reaches.
 * @param connection - mounted Host Connection service.
 * @param request - Fetch-shaped request; aborting its signal abandons the Node request.
 * @returns Fetch-shaped response once the streaming handler completes.
 */
export function httpFetch(connection: HostConnectionService, request: Request): Promise<Response> {
  const req = new PassThrough() as PassThrough & IncomingMessage
  req.method = request.method
  req.url = new URL(request.url).pathname + new URL(request.url).search
  req.headers = Object.fromEntries(request.headers.entries())
  let status = 0
  const headers = new Map<string, string>()
  const res = new PassThrough() as PassThrough & ServerResponse
  const upstreamEnd = res.end.bind(res)
  const complete = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => { resolve(Buffer.concat(chunks)) })
    res.on('error', reject)
  })
  Object.assign(res, {
    writeHead(code: number, head?: Record<string, string>) {
      status = code
      for (const [name, value] of Object.entries(head ?? {})) headers.set(name.toLowerCase(), value)
      return res
    },
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value) },
    end(payload?: string | Buffer) {
      if (payload !== undefined) res.write(payload)
      upstreamEnd()
      queueMicrotask(() => { res.emit('close') })
      return res
    },
  })
  const signal = request.signal
  if (signal.aborted) queueMicrotask(() => { req.destroy() })
  else signal.addEventListener('abort', () => { req.destroy() }, { once: true })
  return (async () => {
    const matched = await connection.dispatchHttp(req, res)
    if (!matched) return new Response('not found', { status: 404 })
    const payload = await complete
    return new Response(new Uint8Array(payload), {
      status: status === 0 ? 200 : status,
      headers: Object.fromEntries(headers),
    })
  })()
}
