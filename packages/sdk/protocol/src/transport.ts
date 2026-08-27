/**
 * Newline-delimited JSON-RPC 2.0 over byte streams. Frames with `id` and
 * `method` are requests, `id` alone is a response, and `method` alone is a
 * notification. Malformed lines are ignored; handler failures become error frames.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/transport
 */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

type JsonRpcId = string | number
type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>
type NotificationHandler = (method: string, params: Record<string, unknown>) => void

/** A JSON-RPC error response, preserving the wire `code` and optional `data`. */
export class JsonRpcResponseError extends Error {
  /**
   * @param code - the wire error code, or `undefined` when the peer sent none.
   * @param message - the wire error message.
   * @param data - the optional structured error payload, verbatim.
   */
  constructor(readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'JsonRpcResponseError'
  }
}

/**
 * Outbound request and notification surface used by the runtime server and
 * SDK clients.
 */
export interface JsonRpcTransportPeer {
  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @returns the result; rejects with {@link JsonRpcResponseError} on an error
   * response, and with a plain `Error` on a write failure or closure.
   */
  request(method: string, params: object): Promise<unknown>
  /**
   * Send a notification; omitted params produce no `params` member.
   * @param method - the JSON-RPC method name.
   * @param params - the optional notification parameters object.
   */
  notify(method: string, params?: object): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Resource bounds for one newline-delimited JSON-RPC endpoint. */
export interface JsonRpcTransportOptions {
  /** Maximum UTF-8 bytes retained for one input line. */
  maxLineBytes?: number
  /** Maximum number of requests awaiting a response. */
  maxPendingRequests?: number
  /** Maximum concurrently executing inbound request handlers. */
  maxConcurrentIncoming?: number
  /** Maximum bytes accepted by the writable's queued output. */
  maxOutputBytes?: number
}

/** Default UTF-8 byte limit for one JSON-RPC input line. */
export const DEFAULT_MAX_LINE_BYTES = 1 * 1024 * 1024
/** Default number of requests retained while awaiting responses. */
export const DEFAULT_MAX_PENDING_REQUESTS = 1_000
/** Default concurrent inbound handler limit. */
export const DEFAULT_MAX_CONCURRENT_INCOMING = 100
/** Default queued output byte limit. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Line-delimited endpoint over caller-owned streams. {@link start} attaches
 * listeners; {@link close} detaches them and rejects pending requests without
 * destroying the streams. Missing request handlers return `-32601`; handler
 * failures return `-32603`. Notifications without a handler are dropped.
 */
export class JsonRpcLineTransport implements JsonRpcTransportPeer {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private started = false
  private requestHandler: RequestHandler | undefined
  private notificationHandler: NotificationHandler | undefined
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly maxLineBytes: number
  private readonly maxPendingRequests: number
  private readonly maxConcurrentIncoming: number
  private readonly maxOutputBytes: number
  private activeIncoming = 0
  private queuedOutputBytes = 0
  private closed = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: JsonRpcTransportOptions = {},
  ) {
    this.maxLineBytes = positiveBound(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, 'maxLineBytes')
    this.maxPendingRequests = positiveBound(options.maxPendingRequests, DEFAULT_MAX_PENDING_REQUESTS, 'maxPendingRequests')
    this.maxConcurrentIncoming = positiveBound(options.maxConcurrentIncoming, DEFAULT_MAX_CONCURRENT_INCOMING, 'maxConcurrentIncoming')
    this.maxOutputBytes = positiveBound(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes')
  }

  /** Attach the input listeners and begin reading frames. Idempotent. */
  start(): void {
    if (this.started || this.closed) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
  }

  /**
   * Detach listeners and reject pending requests. Safe before {@link start}.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.failPending(new Error('JSON-RPC transport closed'))
  }

  /**
   * Install the request handler, replacing any prior handler.
   * @param handler - resolves to the response `result`; a rejection becomes a
   * `-32603` error response carrying the message.
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * Install the notification handler, replacing any prior handler.
   * @param handler - invoked per notification with the method and normalized
   * params object.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @param signal - optional abandonment signal: aborting removes the pending
   * entry (no state is retained for a response that may never come) and
   * rejects with the signal's reason.
   * @returns the result; rejects per {@link JsonRpcTransportPeer.request}.
   */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC transport closed'))
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new Error('JSON-RPC pending request limit exceeded'))
    }
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      let detach = (): void => {}
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal.reason))
          return
        }
        const onAbort = (): void => {
          this.pending.delete(id)
          reject(abortError(signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.pending.set(id, {
        resolve: (value) => {
          detach()
          resolve(value)
        },
        reject: (error) => {
          detach()
          reject(error)
        },
      })
      try {
        this.write(message)
      } catch (error) {
        this.pending.delete(id)
        detach()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: object): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Wait for prior frame write callbacks. The empty barrier emits no bytes.
   * @returns a promise that settles with the output write callback.
   */
  flush(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC transport closed'))
    return new Promise<void>((resolve, reject) => {
      try {
        this.output.write('', (error) => {
          if (error) reject(error)
          else resolve()
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    this.drainLines()
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
      this.failTransport(new Error(`JSON-RPC input line exceeds ${String(this.maxLineBytes)} bytes`))
    }
  }

  private drainLines(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const rawLine = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      // Check the complete line before parsing it. Checking only the residual
      // buffer in onData() misses an oversized frame that arrives together
      // with its newline, because drainLines removes it first.
      if (Buffer.byteLength(rawLine, 'utf8') > this.maxLineBytes) {
        this.failTransport(new Error(`JSON-RPC input line exceeds ${String(this.maxLineBytes)} bytes`))
        return
      }
      const line = rawLine.trim()
      if (!line) continue
      void this.handleLine(line).catch((error: unknown) => {
        this.failTransport(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }

  private readonly onInputError = (error: Error): void => {
    this.failTransport(error)
  }

  private readonly onInputEnd = (): void => {
    if (this.closed) return
    this.buffer += this.decoder.end()
    this.drainLines()
    this.failTransport(new Error('JSON-RPC input closed'))
  }

  private async handleLine(line: string): Promise<void> {
    if (this.closed) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // Only JSON syntax errors reach this catch; malformed peer lines are ignored.
      return
    }
    if (!message || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      await this.handleIncomingRequest(id, method, objectParams(frame.params))
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      this.handleIncomingResponse(id, frame)
      return
    }
    if (typeof method === 'string') {
      try {
        this.notificationHandler?.(method, objectParams(frame.params))
      } catch {
        // Notification consumers are observers. A faulty callback must not
        // close the wire or reject unrelated pending requests.
      }
    }
  }

  private async handleIncomingRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    if (this.activeIncoming >= this.maxConcurrentIncoming) {
      this.writeError(id, -32000, 'JSON-RPC server is busy')
      return
    }
    const handler = this.requestHandler
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`)
      return
    }
    this.activeIncoming += 1
    try {
      try {
        const result = await handler(method, params)
        this.write({ jsonrpc: '2.0', id, result })
      } catch (error) {
        this.writeError(id, -32603, error instanceof Error ? error.message : String(error))
      }
    } finally {
      this.activeIncoming -= 1
    }
  }

  private handleIncomingResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Record<string, unknown>
      pending.reject(new JsonRpcResponseError(
        typeof error.code === 'number' ? error.code : undefined,
        typeof error.message === 'string' ? error.message : 'JSON-RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) throw new Error('JSON-RPC transport closed')
    const encoded = `${JSON.stringify(message)}\n`
    const bytes = Buffer.byteLength(encoded, 'utf8')
    const writableLength = typeof this.output.writableLength === 'number' ? this.output.writableLength : 0
    const bufferedOutputBytes = Math.max(this.queuedOutputBytes, writableLength)
    if (bytes > this.maxOutputBytes || bufferedOutputBytes + bytes > this.maxOutputBytes) {
      const error = new Error(`JSON-RPC output queue exceeds ${String(this.maxOutputBytes)} bytes`)
      this.failTransport(error)
      throw error
    }
    this.queuedOutputBytes += bytes
    try {
      this.output.write(encoded, (error) => {
        this.queuedOutputBytes = Math.max(0, this.queuedOutputBytes - bytes)
        if (error !== undefined && error !== null) this.failTransport(error)
      })
    } catch (error) {
      this.queuedOutputBytes = Math.max(0, this.queuedOutputBytes - bytes)
      this.failTransport(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private failTransport(error: Error): void {
    if (this.closed) {
      this.failPending(error)
      return
    }
    this.closed = true
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.buffer = ''
    this.failPending(error)
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return resolved
}

/** Normalize JSON-RPC `params` to a plain object (arrays and scalars collapse to `{}`). */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
}

/** Normalize an abort reason into the rejection Error (a non-Error reason is stringified). */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(`JSON-RPC request aborted: ${String(reason)}`)
}
