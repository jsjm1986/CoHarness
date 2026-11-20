/** WebSocket mount for `ctx.remoteDesktop`: registers one upgrade route on
 * `ctx.webServer`, performs the WebSocket handshake, and hands the adapted
 * socket to `RemoteDesktop.serveStream` under the one-time `?token=` the
 * attachment minted. The token — not the route — is the stream credential.
 * @module @deepseek-ai/dsh-remote-desktop-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { RemoteDesktopToken } from '@deepseek-ai/dsh-remote-desktop'
import { WebSocketDuplex } from './ws-duplex.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'remote-desktop-stream'

/** Plugin config: the mounted pathname. */
export interface Config {
  /** Exact pathname the stream upgrade route serves; clients append `?token=`. */
  streamPath?: string
}

/** Validated plugin config: every field defaults. */
export const Config: z<Config> = z.object({
  streamPath: z.string().default('/api/remote-desktop/stream'),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Register `streamPath` as a WebSocket upgrade route: each upgrade carries
 * the attach token in `?token=`, is wrapped as a `Duplex`, and enters
 * `serveStream`, which consumes the token exactly once and pumps RFB with
 * the resolved level enforced. Missing or invalid tokens destroy the socket.
 * Withdrawal removes upgrade admission, aborts owned transports and waits for
 * accepted provider calls and socket closure before releasing the mount.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const streamPath = config.streamPath
  ctx.inject(['webServer', 'remoteDesktop'], (mount) => {
    mount.effect(function* () {
      const provider = mount.remoteDesktop
      const logger = mount.logger
      const wss = new WebSocketServer({ noServer: true })
      const lifetime = new AbortController()
      const sockets = new Set<Duplex>()
      const socketClosures = new Set<Promise<void>>()
      const operations = new Set<Promise<void>>()
      let closing = false
      yield async () => {
        lifetime.abort()
        const pendingSockets = [...socketClosures]
        for (const socket of sockets) socket.destroy()
        for (const ws of wss.clients) ws.terminate()
        const closed = new Promise<void>((resolve, reject) => {
          wss.close((error) => { if (error) reject(error); else resolve() })
        })
        const results = await Promise.allSettled([closed, ...pendingSockets, ...operations])
        const failures: unknown[] = []
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
        if (failures.length > 0) throw new AggregateError(failures, 'Remote-desktop stream shutdown failed.')
      }
      yield mount.webServer.registerUpgrade({
        path: streamPath,
        handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          const token = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('token')
          if (closing || socket.destroyed || token === null || token === '') {
            socket.destroy()
            return
          }
          sockets.add(socket)
          const socketClosed = new Promise<void>((resolve) => { socket.once('close', resolve) })
          socketClosures.add(socketClosed)
          void socketClosed.then(() => { sockets.delete(socket); socketClosures.delete(socketClosed) })
          wss.handleUpgrade(req, socket, head, (ws) => {
            if (closing) { ws.terminate(); return }
            const duplex = new WebSocketDuplex(ws)
            const cancelled = new AbortController()
            const signal = AbortSignal.any([lifetime.signal, cancelled.signal])
            const failed = (error?: Error) => { cancelled.abort(error) }
            duplex.once('close', failed)
            duplex.on('error', failed)
            const operation = Promise.resolve().then(async () => {
              try { await provider.serveStream(RemoteDesktopToken(token), duplex, signal) }
              catch (error) {
                if (!signal.aborted) logger.warn(error instanceof Error ? error : new Error(String(error)))
                duplex.destroy()
              } finally {
                await new Promise<void>((resolve) => {
                  if (duplex.closed) { resolve(); return }
                  duplex.once('close', resolve)
                  duplex.destroy()
                })
                duplex.off('close', failed)
                duplex.off('error', failed)
                operations.delete(operation)
              }
            })
            operations.add(operation)
          })
        },
      })
      yield () => { closing = true }
    }, 'remote-desktop-stream: upgrades and active streams')
  })
}
