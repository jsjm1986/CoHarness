/** Browser WebSocket input channel with transparent fallback signals for TerminalView. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TERMINAL_INPUT_PATH, type TerminalInputClientFrame, type TerminalInputServerFrame } from '../input-protocol.ts'
import type { TerminalAttachmentId, WebTerminalId } from '../types.ts'

/** Raised when the channel is not open before a frame is transmitted, making HTTP fallback safe. */
export class TerminalInputChannelUnavailableError extends Error {
  constructor(message = 'Terminal input WebSocket is not open') {
    super(message)
    this.name = 'TerminalInputChannelUnavailableError'
  }
}

/** Raised when the channel drops after a frame was transmitted, before its acknowledgement arrives. */
export class TerminalInputChannelClosedError extends Error {
  constructor(message = 'Terminal input WebSocket closed before acknowledgement') {
    super(message)
    this.name = 'TerminalInputChannelClosedError'
  }
}

/** Persistent low-latency input transport bound to one active terminal output attachment. */
export interface TerminalInputChannel {
  /** True only while the WebSocket is open and accepting frames. */
  readonly isOpen: boolean
  /**
   * Send raw UTF-8 terminal input over the open WebSocket and await Host acceptance.
   * @param data - coalesced input text.
   * @returns after the Host confirms acceptance.
   */
  write(data: string): Promise<void>
  /**
   * Send a PTY resize over the open WebSocket and await Host completion.
   * @param cols - column count.
   * @param rows - row count.
   * @returns after the Host completes the resize.
   */
  resize(cols: number, rows: number): Promise<void>
  /** Close the WebSocket and reject any in-flight acknowledgements. */
  close(): void
}

/** Arguments identifying the active terminal output attachment an input WebSocket binds to. */
export interface TerminalInputChannelTarget {
  readonly sessionId: SessionId
  readonly terminalId: WebTerminalId
  readonly attachmentId: TerminalAttachmentId
}

/** Optional factory creating a persistent input channel for a writable attachment. */
export type TerminalInputChannelFactory = (target: TerminalInputChannelTarget) => TerminalInputChannel | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseServerFrame(raw: unknown): TerminalInputServerFrame | undefined {
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (!isRecord(parsed) || typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq) || parsed.seq < 1) {
    return undefined
  }
  if (parsed.type === 'ack') return { type: 'ack', seq: parsed.seq }
  if (parsed.type === 'error' && typeof parsed.message === 'string') {
    const code = typeof parsed.code === 'string' ? parsed.code : undefined
    const details = isRecord(parsed.details) ? parsed.details : undefined
    return {
      type: 'error',
      seq: parsed.seq,
      message: parsed.message,
      ...(code === undefined ? {} : { code }),
      ...(details === undefined ? {} : { details }),
    }
  }
  return undefined
}

/**
 * Open a browser WebSocket bound to one verified Session and attachment identity.
 * Returns undefined in environments without `WebSocket` or a page origin.
 * @param target - active Session, terminal, and attachment identifiers.
 * @param privateResourceUrl - pins the upgrade URL to the verified principal and Runtime.
 * @returns an input channel whose `isOpen` flips true once the handshake succeeds.
 */
export function openWebSocketTerminalInputChannel(
  target: TerminalInputChannelTarget,
  privateResourceUrl?: (value: string, sessionId: SessionId) => string,
): TerminalInputChannel | undefined {
  const WS = globalThis.WebSocket
  const href = (globalThis as { location?: { href?: string } }).location?.href
  if (typeof WS !== 'function' || typeof href !== 'string') return undefined
  const query = new URLSearchParams({
    sessionId: target.sessionId,
    terminalId: target.terminalId,
    attachmentId: target.attachmentId,
  })
  const path = `${TERMINAL_INPUT_PATH}?${query.toString()}`
  let url: URL
  try {
    // Pin on the http(s) URL before converting to ws(s): the identity fence checks page origin.
    url = new URL(privateResourceUrl?.(path, target.sessionId) ?? path, href)
  } catch {
    return undefined
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  let socket: WebSocket
  try {
    socket = new WS(url.href)
  } catch {
    return undefined
  }

  let closed = false
  let nextSeq = 1
  const pending = new Map<number, { resolve: () => void; reject: (error: unknown) => void }>()

  const failPending = (): void => {
    if (closed) return
    closed = true
    const error = new TerminalInputChannelClosedError()
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  socket.addEventListener('message', (event) => {
    const frame = parseServerFrame(event.data)
    if (frame === undefined) return
    const waiter = pending.get(frame.seq)
    if (waiter === undefined) return
    pending.delete(frame.seq)
    if (frame.type === 'ack') {
      waiter.resolve()
      return
    }
    if (frame.code !== undefined) {
      waiter.reject(new RemoteError(frame.code as never, frame.message, (frame.details ?? {}) as never))
      return
    }
    waiter.reject(new Error(frame.message))
  })
  socket.addEventListener('close', failPending)
  socket.addEventListener('error', () => {
    failPending()
    if (socket.readyState === WS.OPEN || socket.readyState === WS.CONNECTING) socket.close()
  })

  const send = (frame: TerminalInputClientFrame): Promise<void> => {
    if (closed || socket.readyState !== WS.OPEN) {
      return Promise.reject(new TerminalInputChannelUnavailableError())
    }
    return new Promise<void>((resolve, reject) => {
      pending.set(frame.seq, { resolve, reject })
      try {
        socket.send(JSON.stringify(frame))
      } catch {
        pending.delete(frame.seq)
        failPending()
        reject(new TerminalInputChannelUnavailableError())
      }
    })
  }

  return {
    get isOpen() {
      return !closed && socket.readyState === WS.OPEN
    },
    write(data: string) {
      return send({ type: 'write', seq: nextSeq++, data })
    },
    resize(cols: number, rows: number) {
      return send({ type: 'resize', seq: nextSeq++, cols, rows })
    },
    close() {
      failPending()
      if (socket.readyState === WS.OPEN || socket.readyState === WS.CONNECTING) {
        socket.close(1000, 'detached')
      }
    },
  }
}
