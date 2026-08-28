/** Browser API carrier: HTTP upstream plus one bounded WebSocket downlink per event stream. */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../api-path.ts'

type Parser<F> = { parse(value: unknown): F }

/** Bound one browser downlink's retained burst before reconnecting it. */
const SOCKET_QUEUE_MAX_ITEMS = 1024
const SOCKET_QUEUE_MAX_BYTES = 8 * 1024 * 1024
const socketEncoder = new TextEncoder()

interface QueuedSocketItem<F> {
  item: RpcRequest<F>
  bytes: number
}

/** Head-indexed, byte-bounded FIFO for a WebSocket downlink. */
class SocketQueue<F> {
  private values: QueuedSocketItem<F>[] = []
  private head = 0
  private bytes = 0

  /** Number of retained items. */
  get length(): number {
    return this.values.length - this.head
  }

  /** Append one item when both queue budgets allow it. */
  push(item: RpcRequest<F>, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SOCKET_QUEUE_MAX_BYTES
      || this.length >= SOCKET_QUEUE_MAX_ITEMS
      || this.bytes > SOCKET_QUEUE_MAX_BYTES - bytes) return false
    this.values.push({ item, bytes })
    this.bytes += bytes
    return true
  }

  /** Remove the oldest item and release its byte accounting. */
  shift(): RpcRequest<F> | undefined {
    if (this.head >= this.values.length) return undefined
    const next = this.values[this.head] as QueuedSocketItem<F>
    this.head += 1
    this.bytes -= next.bytes
    if (this.head >= 64 && this.head * 2 >= this.values.length) {
      this.values = this.values.slice(this.head)
      this.head = 0
    }
    return next.item
  }

  /** Drop all retained items. */
  clear(): void {
    this.values = []
    this.head = 0
    this.bytes = 0
  }
}

/** Browser platform subclass: unary/respond use fetch; mux/host use downlink-only WebSockets. */
export class WebApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox = new SocketQueue<F>()
    let wake: (() => void) | undefined
    let ended = false
    const isEnded = (): boolean => ended
    const closeForOverflow = (): void => {
      if (ended) return
      ended = true
      inbox.clear()
      socket.close()
      wake?.()
      wake = undefined
    }
    const enqueue = (item: RpcRequest<F>, bytes: number): boolean => {
      if (ended) return false
      if (!inbox.push(item, bytes)) {
        // A stalled browser consumer must not turn a server burst into an
        // unbounded heap. Reconnect semantics already treat close as a failed
        // generation, so discard the burst and publish one terminal edge.
        console.error(`[client-connection] WebSocket downlink queue exceeded its ${String(SOCKET_QUEUE_MAX_ITEMS)}-item/${String(SOCKET_QUEUE_MAX_BYTES)}-byte budget on ${path}`)
        closeForOverflow()
        return false
      }
      wake?.()
      wake = undefined
      return true
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent): void => {
      if (typeof event.data !== 'string') {
        console.error(`[client-connection] dropping malformed WebSocket frame on ${path}: binary frames are unsupported`)
        return
      }
      const bytes = socketEncoder.encode(event.data).byteLength
      if (bytes > SOCKET_QUEUE_MAX_BYTES) {
        console.error(`[client-connection] WebSocket downlink frame exceeded its ${String(SOCKET_QUEUE_MAX_BYTES)}-byte budget on ${path}`)
        closeForOverflow()
        return
      }
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(JSON.parse(event.data))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed WebSocket frame on ${path}:`, error)
        return
      }
      const accepted = enqueue(
        { rpcId: full.rpcId, payload: frame },
        bytes,
      )
      if (accepted) this.onEnvelope(full)
    }
    const handleClose = (): void => {
      if (ended) return
      ended = true
      wake?.()
      wake = undefined
    }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          yield inbox.shift() as RpcRequest<F>
        }
        if (isEnded()) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      handleAbort()
    }
  }
}
