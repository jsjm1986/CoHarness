/** Authenticated bidirectional WebSocket channel support on top of Connection's trust fence. */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { ConnectionRpcAuthority } from './rpc.ts'
import { rejectWebSocketUpgrade } from './websocket-downlink.ts'

/** Allow a busy event loop to miss two protocol heartbeats before closing. */
const MAX_MISSED_HEARTBEATS = 2

/** Default maximum incoming WebSocket text frame payload size in bytes. */
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024

/** Minimal text-oriented WebSocket surface handed to an accepted Connection upgrade handler. */
export interface ConnectionWebSocket {
  /** Aborted when the socket closes, errors, or the owning route is disposed. */
  readonly signal: AbortSignal
  /** Current socket lifecycle phase. */
  readonly readyState: 'open' | 'closing' | 'closed'
  /**
   * Queue one UTF-8 text frame if the socket is still open.
   * @param data - serialized text frame payload.
   */
  send(data: string): void
  /**
   * Initiate a clean WebSocket close if the socket has not already closed.
   * @param code - RFC 6455 close status code.
   * @param reason - short UTF-8 close reason.
   */
  close(code?: number, reason?: string): void
  /**
   * Subscribe to incoming UTF-8 text frames.
   * @param listener - callback receiving each decoded text payload.
   * @returns disposer removing the listener.
   */
  onMessage(listener: (data: string) => void): () => void
  /**
   * Subscribe to socket closure.
   * @param listener - callback invoked once when the socket closes.
   * @returns disposer removing the listener.
   */
  onClose(listener: () => void): () => void
}

/** Handler invoked after Connection's trust fence, `connection/request`, and optional route authorization succeed. */
export type ConnectionWebSocketHandler = (
  socket: ConnectionWebSocket,
  request: IncomingMessage,
) => void | Promise<void>

/** Policy and framing limits for one Connection-managed WebSocket upgrade route. */
export interface ConnectionWebSocketOptions {
  /** Trust boundary applied before upgrading: `'trusted-host'` or `'loopback'`. */
  readonly authority: ConnectionRpcAuthority
  /** Maximum incoming WebSocket frame payload in bytes; defaults to 256 KiB. */
  readonly maxMessageBytes?: number
  /**
   * Optional domain admission check executed inside the `connection/request`
   * waterfall before completing the HTTP 101 handshake.
   * @param request - incoming upgrade request.
   * @param signal - socket lifetime signal.
   * @returns true to complete the upgrade, or false to reject with HTTP 403.
   */
  readonly authorize?: (request: IncomingMessage, signal: AbortSignal) => boolean | Promise<boolean>
}

/** Host registry for authenticated bidirectional WebSocket channels under `/api/`. */
export interface HostConnectionWebSocket {
  /**
   * Register one exact WebSocket upgrade path below `/api/`. Connection applies
   * its Host/Origin fence, authentication, and `connection/request` waterfall
   * before invoking the handler.
   * @param path - exact pathname below `/api/`, such as `/api/terminal/input`.
   * @param handler - callback owning the upgraded socket.
   * @param options - trust authority, payload cap, and optional pre-upgrade check.
   * @returns asynchronous disposer closing active sockets and removing the route.
   */
  handle(
    path: string,
    handler: ConnectionWebSocketHandler,
    options: ConnectionWebSocketOptions,
  ): () => Promise<void>
}

function rawDataToUtf8(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function adaptWebSocket(ws: WebSocket, signal: AbortSignal): ConnectionWebSocket {
  const messageListeners = new Set<(data: string) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false

  const notifyClose = (): void => {
    if (closed) return
    closed = true
    for (const listener of [...closeListeners]) listener()
    closeListeners.clear()
    messageListeners.clear()
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      ws.close(1003, 'binary frames are unsupported')
      return
    }
    const text = rawDataToUtf8(raw)
    for (const listener of [...messageListeners]) listener(text)
  })
  ws.once('close', notifyClose)
  ws.once('error', notifyClose)

  return {
    signal,
    get readyState() {
      if (ws.readyState === WebSocket.OPEN) return 'open'
      if (ws.readyState === WebSocket.CLOSING) return 'closing'
      return 'closed'
    },
    send(data: string) {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(data, (error) => {
        if (error != null && ws.readyState === WebSocket.OPEN) ws.terminate()
      })
    },
    close(code?: number, reason?: string) {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return
      if (code === undefined) ws.close()
      else ws.close(code, reason)
    },
    onMessage(listener) {
      if (closed) return () => {}
      messageListeners.add(listener)
      return () => { messageListeners.delete(listener) }
    },
    onClose(listener) {
      if (closed) {
        listener()
        return () => {}
      }
      closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    },
  }
}

/**
 * Own one `ws` no-server acceptor, heartbeat loop, and clean shutdown for a
 * registered Connection WebSocket channel.
 */
export class ConnectionWebSocketChannel {
  private readonly server: WebSocketServer
  private readonly lifetime = new AbortController()
  private readonly missedHeartbeats = new WeakMap<WebSocket, number>()
  private readonly pending = new Set<Promise<void>>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private closing = false

  /**
   * @param heartbeatIntervalMs - interval between server Ping control frames.
   * @param maxMessageBytes - maximum incoming WebSocket message size in bytes.
   */
  constructor(
    private readonly heartbeatIntervalMs = 30_000,
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  ) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
      throw new RangeError('maxMessageBytes must be a positive safe integer')
    }
    this.server = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes })
  }

  /**
   * Complete one already-admitted upgrade request and invoke the domain handler
   * while the caller's request scope is still active.
   * @param req - incoming HTTP upgrade request.
   * @param socket - raw TCP/Duplex socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   * @param socketSignal - signal aborted on underlying socket close or error.
   * @param handler - domain handler receiving the adapted text WebSocket.
   * @returns after upgrade handoff completes.
   */
  upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    socketSignal: AbortSignal,
    handler: ConnectionWebSocketHandler,
  ): Promise<void> {
    if (this.closing || this.lifetime.signal.aborted || socket.destroyed || socketSignal.aborted) {
      rejectWebSocketUpgrade(socket)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      this.server.handleUpgrade(req, socket, head, (ws) => {
        if (this.closing || this.lifetime.signal.aborted) {
          ws.terminate()
          settle()
          return
        }
        this.startHeartbeat()
        this.missedHeartbeats.set(ws, 0)
        ws.on('pong', () => { this.missedHeartbeats.set(ws, 0) })
        const closed = new AbortController()
        const onStop = (): void => { closed.abort() }
        ws.once('close', onStop)
        ws.once('error', onStop)
        const combined = AbortSignal.any([this.lifetime.signal, socketSignal, closed.signal])
        const adapted = adaptWebSocket(ws, combined)
        let work: Promise<void>
        try {
          const result = handler(adapted, req)
          work = Promise.resolve(result).catch(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'internal error')
          })
        } catch {
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'internal error')
          work = Promise.resolve()
        }
        this.pending.add(work)
        void work.finally(() => { this.pending.delete(work) })
        settle()
      })
    })
  }

  /**
   * Stop accepting upgrades, terminate active sockets, and await handler teardown.
   * @returns after the heartbeat timer, acceptor, and active callbacks settle.
   */
  async close(): Promise<void> {
    this.closing = true
    this.lifetime.abort()
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    for (const ws of this.server.clients) ws.terminate()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.allSettled([...this.pending])
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined || this.closing) return
    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.server.clients) {
        if (ws.readyState !== WebSocket.OPEN) continue
        const missed = this.missedHeartbeats.get(ws) ?? 0
        if (missed >= MAX_MISSED_HEARTBEATS) {
          setImmediate(() => {
            if ((this.missedHeartbeats.get(ws) ?? 0) >= MAX_MISSED_HEARTBEATS) ws.terminate()
          })
          continue
        }
        this.missedHeartbeats.set(ws, missed + 1)
        ws.ping()
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }
}
