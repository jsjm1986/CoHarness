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
import type { Socket } from 'node:net'
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
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const streamPath = config.streamPath
  ctx.inject(['webServer', 'remoteDesktop'], (mount) => {
    const wss = new WebSocketServer({ noServer: true })
    mount.effect(() => mount.webServer.registerUpgrade({
      path: streamPath,
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const token = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('token')
        if (token === null || token === '') {
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket as Socket, head, (ws) => {
          const duplex = new WebSocketDuplex(ws)
          void mount.remoteDesktop.serveStream(RemoteDesktopToken(token), duplex)
            .catch(() => duplex.destroy())
        })
      },
    }), 'remote-desktop-stream: stream upgrade route')
  })
}
