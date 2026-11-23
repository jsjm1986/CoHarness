/** Host-side WebSocket handler delivering low-latency terminal input and resize frames. */
import type { IncomingMessage } from 'node:http'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TerminalCreatorId } from './authorization.ts'
import type { TerminalInputClientFrame, TerminalInputServerFrame } from './input-protocol.ts'
import type { BrowserTerminal } from './terminal.ts'
import type { TerminalAttachmentId, WebTerminalId } from './types.ts'

/** Minimal text WebSocket contract consumed from `ctx.connection.ws` without circular host references. */
export type TerminalInputSocket = {
  readonly signal: AbortSignal
  readonly readyState: 'open' | 'closing' | 'closed'
  readonly send: (frame: string) => void
  readonly close: (code?: number, reason?: string) => void
  readonly onMessage: (onFrame: (frame: string) => void) => () => void
  readonly onClose: (onEnd: () => void) => () => void
}

/** Structural subset of `ctx.connection` used to register the terminal input upgrade route. */
export interface TerminalInputConnectionService {
  readonly ws?: {
    handle(
      path: string,
      handler: (socket: TerminalInputSocket, request: IncomingMessage) => void | Promise<void>,
      options: {
        readonly authority: 'trusted-host' | 'loopback'
        readonly maxMessageBytes?: number
        readonly authorize?: (request: IncomingMessage, signal: AbortSignal) => boolean | Promise<boolean>
      },
    ): () => Promise<void>
  }
}

const ID_PATTERN = /^[\w-]{1,128}$/u
const MAX_PENDING_INPUT_FRAMES = 64

/** Live output-stream attachment eligible to bind a low-latency input WebSocket. */
export interface ActiveTerminalAttachment {
  readonly key: string
  readonly sessionId: SessionId
  readonly terminalId: WebTerminalId
  readonly attachmentId: TerminalAttachmentId
  readonly creator: TerminalCreatorId
  readonly terminal: BrowserTerminal
  readonly signal: AbortSignal
  readonly isClosed: () => boolean
  inputSocket?: TerminalInputSocket | undefined
}

/** Validated query parameters extracted from one `/api/terminal/input` upgrade request. */
export interface TerminalInputQuery {
  readonly sessionId: SessionId
  readonly terminalId: WebTerminalId
  readonly attachmentId: TerminalAttachmentId
}

/**
 * Parse and validate the exact attachment coordinates from an upgrade URL.
 * @param url - raw upgrade request URL.
 * @returns validated identifiers, or undefined if missing or malformed.
 */
export function parseTerminalInputQuery(url: string | undefined): TerminalInputQuery | undefined {
  let parsed: URL
  try {
    parsed = new URL(url ?? '/', 'http://dsh.internal')
  } catch {
    return undefined
  }
  const sessionId = parsed.searchParams.get('sessionId')
  const terminalId = parsed.searchParams.get('terminalId')
  const attachmentId = parsed.searchParams.get('attachmentId')
  if (sessionId === null || sessionId.length === 0 || sessionId.length > 256
    || terminalId === null || !ID_PATTERN.test(terminalId)
    || attachmentId === null || !ID_PATTERN.test(attachmentId)) {
    return undefined
  }
  return {
    sessionId: sessionId as SessionId,
    terminalId: terminalId as WebTerminalId,
    attachmentId: attachmentId as TerminalAttachmentId,
  }
}

/**
 * Build the lookup key indexing one active `follow()` attachment.
 * @param sessionId - Session owning the terminal.
 * @param terminalId - Host terminal identity.
 * @param attachmentId - exclusive output attachment identity.
 * @returns deterministic composite lookup key.
 */
export function terminalAttachmentKey(
  sessionId: SessionId,
  terminalId: WebTerminalId,
  attachmentId: TerminalAttachmentId,
): string {
  return JSON.stringify([sessionId, terminalId, attachmentId])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseClientFrame(raw: string): TerminalInputClientFrame | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (!isRecord(parsed) || typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq) || parsed.seq < 1) {
    return undefined
  }
  if (parsed.type === 'write' && typeof parsed.data === 'string') {
    return { type: 'write', seq: parsed.seq, data: parsed.data }
  }
  if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
    return { type: 'resize', seq: parsed.seq, cols: parsed.cols, rows: parsed.rows }
  }
  return undefined
}

/**
 * Bind an authenticated input WebSocket to a live terminal attachment, serializing
 * write/resize operations and closing immediately when attachment authority ends.
 * @param socket - upgraded Connection WebSocket.
 * @param attachment - active `follow()` attachment verified for this caller.
 * @param limits - input size and geometry validators matching the HTTP RPC contract.
 * @param controllerSignal - controller disposal signal.
 * @returns after the input subscription ends and any accepted frame settles.
 */
export async function bindTerminalInputSocket(
  socket: TerminalInputSocket,
  attachment: ActiveTerminalAttachment,
  limits: {
    readonly maxInputBytes: number
    readonly validateDimensions: (cols: number, rows: number) => void
  },
  controllerSignal: AbortSignal,
): Promise<void> {
  if (attachment.signal.aborted || controllerSignal.aborted || socket.signal.aborted || socket.readyState !== 'open' || attachment.isClosed()) {
    socket.close(1008, 'terminal unavailable')
    return
  }
  if (attachment.inputSocket !== undefined && attachment.inputSocket !== socket) {
    attachment.inputSocket.close(1000, 'replaced')
  }
  attachment.inputSocket = socket
  const lifetime = AbortSignal.any([attachment.signal, controllerSignal])
  const ended = Promise.withResolvers<void>()
  const isEnded = (): boolean => lifetime.aborted || socket.signal.aborted || attachment.isClosed()
    || attachment.inputSocket !== socket || socket.readyState !== 'open'

  let queue: Promise<void> = Promise.resolve()
  let pendingFrames = 0
  const unsubscribeMessage = socket.onMessage((raw) => {
    if (isEnded()) return
    const frame = parseClientFrame(raw)
    if (frame === undefined) {
      socket.close(1008, 'invalid terminal input frame')
      finish()
      return
    }
    if (pendingFrames >= MAX_PENDING_INPUT_FRAMES) {
      socket.close(1008, 'terminal input queue full')
      finish()
      return
    }
    pendingFrames += 1
    queue = queue.then(async () => {
      pendingFrames -= 1
      if (isEnded()) {
        closeOnAbort()
        return
      }
      let reply: TerminalInputServerFrame
      try {
        if (frame.type === 'write') {
          if (Buffer.byteLength(frame.data, 'utf8') > limits.maxInputBytes) {
            throw new Error('Terminal input exceeds the configured limit')
          }
          await attachment.terminal.write(attachment.attachmentId, frame.data)
        } else {
          limits.validateDimensions(frame.cols, frame.rows)
          await attachment.terminal.resize(attachment.attachmentId, frame.cols, frame.rows)
        }
        reply = { type: 'ack', seq: frame.seq }
      } catch (error) {
        if (error instanceof RemoteError) {
          reply = {
            type: 'error',
            seq: frame.seq,
            code: String(error.code),
            message: error.message,
            details: error.details as Record<string, unknown>,
          }
        } else reply = { type: 'error', seq: frame.seq, message: error instanceof Error ? error.message : String(error) }
      }
      if (isEnded()) { closeOnAbort(); return }
      socket.send(JSON.stringify(reply))
    })
  })

  const finish = (): void => {
    unsubscribeMessage()
    lifetime.removeEventListener('abort', closeOnAbort)
    if (attachment.inputSocket === socket) delete attachment.inputSocket
    ended.resolve()
  }
  const closeOnAbort = (): void => {
    if (socket.readyState === 'open') socket.close(1008, 'terminal unavailable')
    finish()
  }
  lifetime.addEventListener('abort', closeOnAbort, { once: true })
  const unsubscribeClose = socket.onClose(finish)
  await ended.promise
  unsubscribeClose()
  await queue
}

/**
 * Helper validating that an incoming upgrade request targets a live attachment owned by the caller.
 * @param request - incoming HTTP upgrade request.
 * @param lookup - resolver for active `follow()` attachments.
 * @param verifyCreator - creator verification callback from `TerminalAccess`.
 * @returns the matched attachment, or undefined to refuse the upgrade.
 */
export function resolveAuthorizedTerminalAttachment(
  request: IncomingMessage,
  lookup: (key: string) => ActiveTerminalAttachment | Iterable<ActiveTerminalAttachment> | undefined,
  verifyCreator: (creator: TerminalCreatorId) => boolean,
): ActiveTerminalAttachment | undefined {
  const query = parseTerminalInputQuery(request.url)
  if (query === undefined) return undefined
  const found = lookup(terminalAttachmentKey(query.sessionId, query.terminalId, query.attachmentId))
  if (found === undefined) return undefined
  const candidates = Symbol.iterator in found ? found : [found]
  for (const attachment of candidates) {
    if (attachment.signal.aborted || attachment.isClosed()) continue
    if (verifyCreator(attachment.creator)) return attachment
  }
  return undefined
}
