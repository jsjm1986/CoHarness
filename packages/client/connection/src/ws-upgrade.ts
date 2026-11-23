/** Shared WebSocket upgrade admission, request-boundary building, and protocol heartbeat helpers. */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import WebSocket, { type WebSocketServer } from 'ws'
import type { ConnectionRequestBoundary } from './index.ts'
import { rejectWebSocketUpgrade } from './websocket-downlink.ts'

/** Allow a busy event loop to miss two protocol heartbeats before closing. */
export const MAX_MISSED_HEARTBEATS = 2

/** Managed protocol Ping/Pong monitor bound to one no-server `WebSocketServer`. */
export interface WebSocketHeartbeat {
  /** Start tracking one upgraded socket and arm the unref'ed interval timer. */
  track(socket: WebSocket): void
  /** Clear the heartbeat interval timer during teardown. */
  stop(): void
}

/**
 * Create a protocol Ping/Pong monitor terminating sockets that miss two consecutive heartbeats.
 * @param server - no-server WebSocket acceptor owning the tracked clients.
 * @param intervalMs - milliseconds between server Ping control frames.
 * @returns lifecycle hooks to track accepted sockets and stop the timer on close.
 */
export function createWebSocketHeartbeat(server: WebSocketServer, intervalMs: number): WebSocketHeartbeat {
  const missedHeartbeats = new Map<WebSocket, number>()
  let timer: NodeJS.Timeout | undefined

  const start = (): void => {
    if (timer !== undefined) return
    timer = setInterval(() => {
      for (const [socket, missed] of missedHeartbeats) {
        if (socket.readyState !== WebSocket.OPEN) {
          missedHeartbeats.delete(socket)
          continue
        }
        if (missed >= MAX_MISSED_HEARTBEATS) {
          // Give a pong already queued by the event loop one turn to arrive before terminating.
          setImmediate(() => {
            if (missedHeartbeats.get(socket) === missed) socket.terminate()
          })
          continue
        }
        missedHeartbeats.set(socket, missed + 1)
        socket.ping()
      }
    }, intervalMs)
    timer.unref()
  }

  return {
    track(socket: WebSocket): void {
      // Keep server parameter referenced for caller symmetry while tracking active sockets explicitly.
      void server
      start()
      missedHeartbeats.set(socket, 0)
      const onPong = (): void => { missedHeartbeats.set(socket, 0) }
      const untrack = (): void => {
        missedHeartbeats.delete(socket)
        socket.removeListener('pong', onPong)
      }
      socket.on('pong', onPong)
      socket.once('close', untrack)
      socket.once('error', untrack)
    },
    stop(): void {
      missedHeartbeats.clear()
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
  }
}

/**
 * Construct the immutable `connection/request` waterfall payload for one HTTP or upgrade request.
 * @param kind - carrier kind entering the Connection boundary.
 * @param req - incoming Node HTTP request.
 * @param signal - optional upgrade socket lifetime signal.
 * @returns request descriptor passed through `waterfall('connection/request')`.
 */
export function buildConnectionRequestBoundary(
  kind: 'http' | 'upgrade',
  req: IncomingMessage,
  signal?: AbortSignal,
): ConnectionRequestBoundary {
  return {
    kind,
    headers: req.headers,
    ...(signal === undefined ? {} : { signal }),
    ...(req.method === undefined ? {} : { method: req.method }),
    pathname: new URL(req.url ?? '/', 'http://dsh.internal').pathname,
    ...(req.url === undefined ? {} : { url: req.url }),
  }
}

/**
 * Build one upgrade route handler enforcing Connection's trust fence, socket lifetime,
 * and `connection/request` waterfall before delegating to the accepted upgrade callback.
 * @param options - owning Cordis context, rejection predicate, and accepted-upgrade callback.
 * @returns handler suitable for `webServer.registerUpgrade(...)`.
 */
export function createUpgradeRouteHandler(options: {
  readonly owner: Context
  readonly isRejected: (req: IncomingMessage) => boolean
  readonly onAccepted: (req: IncomingMessage, socket: Duplex, head: Buffer, signal: AbortSignal) => Promise<void>
  readonly rejectOnError?: boolean
}): WebUpgradeRoute['handler'] {
  return (req, socket, head) => {
    if (options.isRejected(req)) {
      rejectWebSocketUpgrade(socket)
      return
    }
    const lifetime = new AbortController()
    const close = (): void => {
      socket.removeListener('close', close)
      socket.removeListener('error', close)
      lifetime.abort()
    }
    socket.once('close', close)
    socket.once('error', close)
    if (socket.destroyed) close()
    let handedOff = false
    return options.owner.waterfall(
      'connection/request',
      buildConnectionRequestBoundary('upgrade', req, lifetime.signal),
      async () => {
        await options.onAccepted(req, socket, head, lifetime.signal)
        handedOff = true
      },
    ).catch((error: unknown) => {
      close()
      if (options.rejectOnError === true && !socket.destroyed && !socket.writableEnded) {
        if (handedOff) socket.destroy()
        else rejectWebSocketUpgrade(socket)
      }
      throw error
    })
  }
}
