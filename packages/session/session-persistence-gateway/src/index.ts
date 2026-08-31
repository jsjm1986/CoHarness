/** Gateway PostgreSQL session persistence provider. @module @deepseek-ai/dsh-session-persistence-gateway */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-collaboration'
import type {
  GatewayRequestPrincipal,
  GatewayRuntimeRequestInit,
} from '@deepseek-ai/dsh-gateway-runtime'
import {
  DEFAULT_GATEWAY_RESPONSE_MAX_BYTES,
  GatewayResponseTooLargeError,
  readGatewayResponseJson,
} from '@deepseek-ai/dsh-gateway-runtime'
import {
  GatewaySessionCreationAuthorization,
  type GatewaySessionCreationAuthorization as SessionCreationAuthorization,
} from '@deepseek-ai/dsh-gateway-runtime'
import {
  isSurfaceEligibleType,
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type SessionPreparation,
} from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_MAX_PENDING_EVENTS_PER_SESSION,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  DEFAULT_SESSION_HISTORY_INDEX_MAX_ITEMS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistenceRevision,
  type SessionDraftReservation,
  type SessionDraftReservationRequest,
  type SessionContentMetadata,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type SessionHistoryIndex,
  type SessionHistoryIndexItem,
  type SessionPersistenceRevision as PersistenceRevision,
  SessionPersistenceReadError,
  SessionPersistenceReadCursor,
  type SessionPersistencePage,
  type SessionPersistencePageRequest,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const GATEWAY_SESSION_RESPONSE_MAX_BYTES = DEFAULT_GATEWAY_RESPONSE_MAX_BYTES
/** Reserve one quarter of the 64 MiB Gateway request ceiling for JSON envelope overhead. */
export const DEFAULT_GATEWAY_MAX_PENDING_BYTES = Math.floor(GATEWAY_SESSION_RESPONSE_MAX_BYTES * 0.75)
/** One page has a 512 KiB event budget; retain bounded envelope headroom on the wire. */
const GATEWAY_SESSION_PAGE_RESPONSE_MAX_BYTES = 1024 * 1024
const EVENT_ENVELOPE_KEYS = new Set([
  'type',
  'seq',
  'time',
  'data',
  'surfaceOp',
  'sourceEventSeqs',
  'ignorable',
])

interface PendingSessionCreation {
  visibility: 'project' | 'private'
  header: SessionHeader
  authorization: Promise<SessionCreationAuthorization>
  unregister: () => void
}

interface DraftReservationState {
  request: SessionDraftReservationRequest
}

/** Provider tunables for coordinator caching, write coalescing, and loopback requests. */
export interface Config {
  /** Maximum number of cold prepared sessions retained for a later resume. */
  preparedSessionCacheSize?: number
  /** Maximum delay before one live event batch is flushed. */
  writeBatchMaxDelayMs?: number
  /** Maximum events retained in one live session's pending write queue. */
  maxPendingEvents?: number
  /** Maximum UTF-8 JSON bytes retained in one live session's pending write queue. */
  maxPendingBytes?: number
  /** Deadline for one internal Gateway HTTP request. */
  requestTimeoutMs?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function surfaceOp(value: unknown): boolean {
  if (value === 'append') return true
  const operation = record(value)
  return operation !== undefined
    && Object.keys(operation).length === 3
    && operation.op === 'replace'
    && nonNegativeInteger(operation.start)
    && nonNegativeInteger(operation.end)
}

function jsonSerializable(value: unknown): boolean {
  try {
    const encoded: unknown = JSON.stringify(value)
    return typeof encoded === 'string'
  } catch {
    return false
  }
}

/** Preserve a stable persistence category across fetch and response decoding. */
function classifyGatewayReadError(
  error: unknown,
  callerSignal?: AbortSignal,
  effectiveSignal?: AbortSignal,
): SessionPersistenceReadError {
  if (error instanceof SessionPersistenceReadError) return error
  if (callerSignal?.aborted) {
    return new SessionPersistenceReadError('aborted', 'Gateway session persistence request was cancelled', { cause: error })
  }
  if (effectiveSignal?.aborted) {
    return new SessionPersistenceReadError('timeout', 'Gateway session persistence request timed out', { cause: error })
  }
  if (error instanceof GatewayResponseTooLargeError) {
    return new SessionPersistenceReadError('too-large', 'Gateway session persistence response exceeds its byte limit', { cause: error })
  }
  if (error instanceof SyntaxError) {
    return new SessionPersistenceReadError('protocol', 'Gateway session persistence returned invalid JSON', { cause: error })
  }
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined
  if (code === 'ETIMEDOUT' || code === '57014' || (error instanceof Error && error.name === 'TimeoutError')) {
    return new SessionPersistenceReadError('timeout', 'Gateway session persistence request timed out', { cause: error })
  }
  return new SessionPersistenceReadError('dependency', 'Gateway session persistence is temporarily unavailable', { cause: error })
}

/** Convert response-shape validation failures into the public protocol category. */
function protocolReadError(error: unknown, fallback: string): SessionPersistenceReadError {
  if (error instanceof SessionPersistenceReadError) return error
  return new SessionPersistenceReadError(
    'protocol',
    error instanceof Error && error.message !== '' ? error.message : fallback,
    { cause: error },
  )
}

function headerFrom(value: unknown): SessionHeader {
  const header = record(value)
  if (typeof header?.id !== 'string' || header.id === '' || !safeInteger(header.version)
    || !nonNegativeInteger(header.createdAt) || !optionalString(header.cwd)
    || !optionalString(header.parentSession)
    || (header.seedLength !== undefined && !nonNegativeInteger(header.seedLength))
    || (header.origin !== undefined && header.origin !== 'subagent')
    || (header.delegationDepth !== undefined && !nonNegativeInteger(header.delegationDepth))
    || !optionalString(header.agentPreset)
    || (header.draft !== undefined && typeof header.draft !== 'boolean')) {
    throw new Error('Gateway returned an invalid session header')
  }
  return {
    id: SessionId(header.id),
    version: header.version,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: SessionId(header.parentSession) }),
    ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    ...(header.draft === undefined ? {} : { draft: header.draft }),
  }
}

function contentMetadataFrom(value: unknown): SessionContentMetadata | undefined {
  if (value === undefined) return undefined
  const content = record(value)
  const visibleContentSeq = content?.visibleContentSeq
  const lastPromptAt = content?.lastPromptAt
  if (typeof content?.blank !== 'boolean'
    || (visibleContentSeq !== null && !nonNegativeInteger(visibleContentSeq))
    || (lastPromptAt !== null && !nonNegativeInteger(lastPromptAt))) {
    throw new Error('Gateway returned invalid session content metadata')
  }
  return {
    blank: content.blank,
    visibleContentSeq: visibleContentSeq === null ? null : visibleContentSeq,
    lastPromptAt: lastPromptAt === null ? null : lastPromptAt,
  }
}

function eventsFrom(value: unknown): SessionEvent[] {
  if (!Array.isArray(value)) throw new Error('Gateway returned an invalid session event list')
  return value.map((candidate) => {
    const event = record(candidate)
    if (event === undefined || !Object.keys(event).every(key => EVENT_ENVELOPE_KEYS.has(key))
      || !Object.hasOwn(event, 'type') || typeof event.type !== 'string' || event.type === ''
      || !Object.hasOwn(event, 'seq') || !nonNegativeInteger(event.seq)
      || !Object.hasOwn(event, 'time') || !nonNegativeInteger(event.time)
      || !Object.hasOwn(event, 'data') || !jsonSerializable(event.data)
      || (Object.hasOwn(event, 'sourceEventSeqs') && (!Array.isArray(event.sourceEventSeqs)
        || !event.sourceEventSeqs.every(nonNegativeInteger)))
      || (Object.hasOwn(event, 'ignorable') && event.ignorable !== true)) {
      throw new Error('Gateway returned an invalid session event list')
    }
    const isSurfaceEvent = isSurfaceEligibleType(event.type) || event.type === 'steering/message'
    const hasSurfaceOp = Object.hasOwn(event, 'surfaceOp')
    const hasSourceEventSeqs = Object.hasOwn(event, 'sourceEventSeqs')
    if ((isSurfaceEvent && (!hasSurfaceOp || !surfaceOp(event.surfaceOp)))
      || (!isSurfaceEvent && (hasSurfaceOp || hasSourceEventSeqs))) {
      throw new Error('Gateway returned an invalid session event list')
    }
    return candidate as SessionEvent
  })
}

function historyIndexFrom(value: unknown, maxItems: number): SessionHistoryIndex {
  const root = record(value)
  if (typeof root?.revision !== 'string' || root.revision === ''
    || !safeInteger(root.asOfSeq) || root.asOfSeq < -1
    || !nonNegativeInteger(root.totalTurns) || typeof root.truncated !== 'boolean'
    || !Array.isArray(root.items) || root.items.length > maxItems
    || root.items.length > root.totalTurns) {
    throw new SessionPersistenceReadError('protocol', 'Gateway returned an invalid history index')
  }
  const items: SessionHistoryIndexItem[] = root.items.map((candidate) => {
    const item = record(candidate)
    const prompt = item?.prompt
    const response = item?.response
    const turn = item?.turn
    const startSeq = item?.startSeq
    const endSeq = item?.endSeq
    const textValid = (text: unknown): text is string | undefined => text === undefined
      || (typeof text === 'string' && Array.from(text).length <= 160)
    if (!nonNegativeInteger(turn) || !nonNegativeInteger(startSeq)
      || !nonNegativeInteger(endSeq) || startSeq > endSeq
      || !textValid(prompt) || !textValid(response)) {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned an invalid history index item')
    }
    return {
      turn,
      startSeq,
      endSeq,
      ...(prompt === undefined ? {} : { prompt }),
      ...(response === undefined ? {} : { response }),
    }
  })
  return {
    revision: SessionPersistenceRevision(root.revision),
    asOfSeq: root.asOfSeq,
    totalTurns: root.totalTurns,
    items,
    truncated: root.truncated,
  }
}

function deterministicBatchId(kind: 'append' | 'repair', sessionId: SessionId, value: unknown): string {
  const bytes = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(JSON.stringify(value))
    .digest()
    .subarray(0, 16)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Gateway-backed session persistence using `PersistenceCoordinator` for lifecycle orchestration. */
export class GatewaySessionPersistence extends SessionPersistence implements PersistenceBackend<never> {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-gateway'

  static inject = ['sessions', 'gatewayRuntime']
  static Config: z<Config> = z.object({
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
    maxPendingEvents: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_EVENTS_PER_SESSION),
    maxPendingBytes: z.number().step(1).min(1).max(DEFAULT_GATEWAY_MAX_PENDING_BYTES)
      .default(DEFAULT_GATEWAY_MAX_PENDING_BYTES),
    requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_REQUEST_TIMEOUT_MS),
  })

  private readonly coordinator: PersistenceCoordinator<never>
  private readonly creations = new Map<SessionId, PendingSessionCreation>()
  private readonly drafts = new Map<SessionId, DraftReservationState>()
  private readonly requestTimeoutMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new RangeError(`session-persistence-gateway requestTimeoutMs must be a positive safe integer no greater than ${String(MAX_TIMER_DELAY_MS)}`)
    }
    this.requestTimeoutMs = requestTimeoutMs
    const maxPendingBytes = config.maxPendingBytes ?? DEFAULT_GATEWAY_MAX_PENDING_BYTES
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1 || maxPendingBytes > DEFAULT_GATEWAY_MAX_PENDING_BYTES) {
      throw new RangeError(`session-persistence-gateway maxPendingBytes must be within 1..${String(DEFAULT_GATEWAY_MAX_PENDING_BYTES)}`)
    }
    ctx.on('session/created', (session) => { this.rememberCreation(session.header) })
    this.coordinator = new PersistenceCoordinator(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
      maxPendingEvents: config.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS_PER_SESSION,
      maxPendingBytes,
    })
    ctx.on('session/disposed', (session) => {
      void ctx.sessions.flush(session).then(
        async () => {
          this.forgetCreation(session.id)
          const draft = this.drafts.get(session.id)
          if (draft !== undefined) {
            try {
              await this.releaseDraft(draft.request)
            } catch (error: unknown) {
              this.ctx.logger.warn(`session-persistence-gateway: draft release for "${session.id}" deferred: ${String(error)}`)
            }
          }
        },
        () => {
          // The coordinator reports the failed retirement; retain creation identity for its retry.
        },
      )
    })
  }

  /** PostgreSQL owns no independent local artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    const creation = this.rememberCreation(meta)
    return this.coordinator.create(meta).catch((error: unknown) => {
      if (creation !== undefined) this.forgetCreation(meta.id, creation)
      throw error
    })
  }

  /* jscpd:ignore-start -- each persistence provider repeats the narrow Service Definition adapter. */
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  /** Ask the authenticated Gateway to remove a root conversation tree. */
  override async remove(id: SessionId, signal?: AbortSignal): Promise<void> {
    await this.request('/internal/runtime/session/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
    }, signal)
  }

  override async reserveDraft(request: SessionDraftReservationRequest): Promise<SessionDraftReservation | undefined> {
    const visibility = request.visibility
      ?? (this.ctx.get('collaboration')?.currentCreation()?.visibility
        ?? (this.ctx.gatewayRuntime.requireCurrent().claims.scope.kind === 'personal' ? 'personal' : 'project'))
    const value = record(await this.request('/internal/runtime/session/draft/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: request.draftId,
        sessionId: request.sessionId,
        cwd: request.cwd,
        visibility,
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      }),
      principal: true,
    }))
    if (typeof value?.sessionId !== 'string' || value.sessionId === ''
      || !nonNegativeInteger(value.leaseExpiresAt)) {
      throw new Error('Gateway returned an invalid draft reservation')
    }
    const canonical = {
      ...request,
      sessionId: SessionId(value.sessionId),
      visibility,
    }
    this.drafts.set(canonical.sessionId, { request: canonical })
    return { sessionId: canonical.sessionId, leaseExpiresAt: value.leaseExpiresAt }
  }

  override async heartbeatDraft(request: SessionDraftReservationRequest): Promise<void> {
    const state = this.drafts.get(request.sessionId)
    if (state === undefined) return
    await this.request('/internal/runtime/session/draft/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: state.request.draftId, sessionId: request.sessionId }),
      principal: true,
    })
  }

  override async releaseDraft(request: SessionDraftReservationRequest): Promise<void> {
    const state = this.drafts.get(request.sessionId)
    if (state === undefined) return
    try {
      await this.request('/internal/runtime/session/draft/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: state.request.draftId, sessionId: request.sessionId }),
      })
    } finally {
      this.drafts.delete(request.sessionId)
    }
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  /** Read one session header through the indexed Gateway metadata endpoint. */
  override async readHeader(id: SessionId, signal?: AbortSignal): Promise<SessionHeader | undefined> {
    const value = record(await this.optional(
      `/internal/runtime/session/meta?sessionId=${encodeURIComponent(id)}`,
      signal,
    ))
    if (value === undefined) return undefined
    if (typeof value.revision !== 'string' || value.revision === '') {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned an invalid session revision')
    }
    let header: SessionHeader
    try {
      header = headerFrom(value.header)
    } catch (error: unknown) {
      throw protocolReadError(error, 'Gateway returned an invalid session header')
    }
    if (header.id !== id) {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned metadata for another session')
    }
    return header
  }

  /** Read one revision without loading the session event log. */
  override readRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    return this.readStoredRevision(id, signal)
  }

  /** Read the bounded turn navigation index from the authenticated Gateway. */
  override async readHistoryIndex(
    id: SessionId,
    maxItems = DEFAULT_SESSION_HISTORY_INDEX_MAX_ITEMS,
    signal?: AbortSignal,
  ): Promise<SessionHistoryIndex | undefined> {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > DEFAULT_SESSION_HISTORY_INDEX_MAX_ITEMS) {
      throw new SessionPersistenceReadError('protocol', 'session history index maxItems is invalid')
    }
    const value = await this.optional(
      `/internal/runtime/session/index?sessionId=${encodeURIComponent(id)}&maxItems=${String(maxItems)}`,
      signal,
    )
    if (value === undefined) return undefined
    return historyIndexFrom(value, maxItems)
  }

  /** Read a bounded page from the Gateway's indexed event range endpoint. */
  override async readPage(
    id: SessionId,
    request: SessionPersistencePageRequest = {},
    signal?: AbortSignal,
  ): Promise<SessionPersistencePage> {
    const query = new URLSearchParams({ sessionId: id })
    if (request.cursor !== undefined) query.set('cursor', request.cursor)
    if (request.beforeSeq !== undefined) query.set('beforeSeq', String(request.beforeSeq))
    if (request.fromSeq !== undefined) query.set('fromSeq', String(request.fromSeq))
    if (request.direction !== undefined) query.set('direction', request.direction)
    if (request.maxBytes !== undefined) query.set('maxBytes', String(request.maxBytes))
    if (request.maxEvents !== undefined) query.set('maxEvents', String(request.maxEvents))
    if (request.maxGroups !== undefined) query.set('maxGroups', String(request.maxGroups))
    const value = record(await this.request(
      `/internal/runtime/session/page?${query.toString()}`,
      {},
      signal,
      GATEWAY_SESSION_PAGE_RESPONSE_MAX_BYTES,
    ))
    if (value === undefined) throw new Error(`session "${id}" not found`)
    if (typeof value.revision !== 'string' || value.revision === '') {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned an invalid session page revision')
    }
    let events: SessionEvent[]
    try {
      events = eventsFrom(value.events)
    } catch (error: unknown) {
      throw protocolReadError(error, 'Gateway returned an invalid session event list')
    }
    const startSeq = value.startSeq === null ? null : value.startSeq
    const endSeq = value.endSeq === null ? null : value.endSeq
    if ((startSeq !== null && !nonNegativeInteger(startSeq))
      || (endSeq !== null && !nonNegativeInteger(endSeq))
      || typeof value.hasMore !== 'boolean'
      || !nonNegativeInteger(value.uncompressedBytes)) {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned invalid session page metadata')
    }
    const cursor = value.nextCursor
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned an invalid session page cursor')
    }
    if ((value.hasMore && cursor === undefined) || (!value.hasMore && cursor !== undefined)) {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned an inconsistent session page continuation')
    }
    let header: SessionHeader
    try {
      header = headerFrom(value.header)
    } catch (error: unknown) {
      throw protocolReadError(error, 'Gateway returned an invalid session header')
    }
    if (header.id !== id) {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned a page for another session')
    }
    const first = events[0]
    const last = events.at(-1)
    if ((first === undefined && (startSeq !== null || endSeq !== null))
      || (last === undefined && (startSeq !== null || endSeq !== null))
      || (first !== undefined && (startSeq !== first.seq || endSeq !== last?.seq))) {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned inconsistent page sequence bounds')
    }
    let previous = -1
    let encodedBytes = 0
    for (const event of events) {
      if (event.seq <= previous || (previous >= 0 && event.seq !== previous + 1)) {
        throw new SessionPersistenceReadError('protocol', 'Gateway returned an unordered session page')
      }
      encodedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8')
      previous = event.seq
    }
    if (value.uncompressedBytes < encodedBytes) {
      throw new SessionPersistenceReadError('protocol', 'Gateway under-reported session page bytes')
    }
    return {
      meta: header,
      revision: SessionPersistenceRevision(value.revision),
      events,
      startSeq,
      endSeq,
      hasMore: value.hasMore,
      ...(cursor === undefined ? {} : { nextCursor: SessionPersistenceReadCursor(cursor) }),
      uncompressedBytes: value.uncompressedBytes,
    }
  }
  /* jscpd:ignore-end */

  private signal(signal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error('Gateway session persistence request timed out'))
    }, this.requestTimeoutMs)
    timer.unref()
    return {
      signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
      dispose: () => { clearTimeout(timer) },
    }
  }

  private rememberCreation(header: SessionHeader): PendingSessionCreation | undefined {
    const creation = this.ctx.get('collaboration')?.currentCreation()
    if (creation === undefined) return this.creations.get(header.id)
    const principal = this.ctx.gatewayRuntime.current()
    if (principal === undefined) {
      throw new Error('Gateway session creation requires an authenticated principal')
    }
    const existing = this.creations.get(header.id)
    if (existing !== undefined) {
      if (existing.visibility !== creation.visibility
        || JSON.stringify(existing.header) !== JSON.stringify(header)) {
        throw new Error(`session "${header.id}" has conflicting Gateway creation metadata`)
      }
      return existing
    }
    const authorization = this.prepareCreation(header, creation.visibility, principal)
    void authorization.catch(() => {})
    const pending: PendingSessionCreation = {
      visibility: creation.visibility,
      header,
      authorization,
      unregister: () => {},
    }
    pending.unregister = this.ctx.gatewayRuntime.registerSessionCreation(header.id, authorization)
    this.creations.set(header.id, pending)
    return pending
  }

  private forgetCreation(id: SessionId, expected?: PendingSessionCreation): void {
    const creation = this.creations.get(id)
    if (creation === undefined || (expected !== undefined && creation !== expected)) return
    this.creations.delete(id)
    creation.unregister()
  }

  private async prepareCreation(
    header: SessionHeader,
    visibility: 'project' | 'private',
    principal: GatewayRequestPrincipal,
  ): Promise<SessionCreationAuthorization> {
    const value = record(await this.request('/internal/runtime/session/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ header, visibility }),
      principal,
    }))
    if (typeof value?.authorization !== 'string' || value.authorization === '') {
      throw new Error('Gateway returned an invalid session creation authorization')
    }
    return GatewaySessionCreationAuthorization(value.authorization)
  }

  private async request(
    path: string,
    init: GatewayRuntimeRequestInit = {},
    signal?: AbortSignal,
    responseLimit = GATEWAY_SESSION_RESPONSE_MAX_BYTES,
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const deadline = this.signal(signal)
    try {
      let response: Response
      try {
        response = await this.ctx.gatewayRuntime.request(path, { ...init, signal: deadline.signal })
      } catch (error: unknown) {
        throw classifyGatewayReadError(error, signal, deadline.signal)
      }
      let value: unknown
      try {
        value = await readGatewayResponseJson(response, responseLimit, deadline.signal)
      } catch (error: unknown) {
        throw classifyGatewayReadError(error, signal, deadline.signal)
      }
      if (!response.ok) {
        const recordValue = record(value)
        const code = recordValue?.code
        if (code === 'too-large' || code === 'aborted' || code === 'timeout'
          || code === 'dependency' || code === 'protocol') {
          const detail = recordValue?.message
          throw new SessionPersistenceReadError(
            code,
            typeof detail === 'string' ? detail : `Gateway session persistence request failed (${code})`,
          )
        }
        const detail = recordValue?.error
        throw new Error(`Gateway session persistence failed: ${typeof detail === 'string' ? detail : `HTTP ${String(response.status)}`}`)
      }
      return value
    } finally {
      deadline.dispose()
    }
  }

  private async optional(path: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const deadline = this.signal(signal)
    try {
      let response: Response
      try {
        response = await this.ctx.gatewayRuntime.request(path, { signal: deadline.signal })
      } catch (error: unknown) {
        throw classifyGatewayReadError(error, signal, deadline.signal)
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {})
        return undefined
      }
      let value: unknown
      try {
        value = await readGatewayResponseJson(response, GATEWAY_SESSION_RESPONSE_MAX_BYTES, deadline.signal)
      } catch (error: unknown) {
        throw classifyGatewayReadError(error, signal, deadline.signal)
      }
      if (!response.ok) {
        const recordValue = record(value)
        const code = recordValue?.code
        if (code === 'too-large' || code === 'aborted' || code === 'timeout'
          || code === 'dependency' || code === 'protocol') {
          const detail = recordValue?.message
          throw new SessionPersistenceReadError(
            code,
            typeof detail === 'string' ? detail : `Gateway session persistence request failed (${code})`,
          )
        }
        throw new Error(`Gateway session persistence failed with HTTP ${String(response.status)}`)
      }
      return value
    } finally {
      deadline.dispose()
    }
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    const value = record(await this.optional(
      `/internal/runtime/session/load?sessionId=${encodeURIComponent(id)}`,
      signal,
    ))
    if (value === undefined) return undefined
    if (typeof value.revision !== 'string' || value.revision === '') {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned an invalid session revision')
    }
    let header: SessionHeader
    try {
      header = headerFrom(value.header)
    } catch (error: unknown) {
      throw protocolReadError(error, 'Gateway returned an invalid session header')
    }
    if (header.id !== id) throw new SessionPersistenceReadError('protocol', 'Gateway returned a different session header')
    let events: SessionEvent[]
    try {
      events = eventsFrom(value.events)
    } catch (error: unknown) {
      throw protocolReadError(error, 'Gateway returned an invalid session event list')
    }
    return {
      meta: header,
      events,
      revision: SessionPersistenceRevision(value.revision),
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    const value = record(await this.request(
      `/internal/runtime/session/revision?sessionId=${encodeURIComponent(id)}`,
      {},
      signal,
    ))
    if (value?.revision === null) return undefined
    if (typeof value?.revision !== 'string' || value.revision === '') {
      throw new SessionPersistenceReadError('protocol', 'Gateway returned an invalid session revision')
    }
    return SessionPersistenceRevision(value.revision)
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    const value = record(await this.optional(
      `/internal/runtime/session/read-from?sessionId=${encodeURIComponent(id)}&fromSeq=${String(fromSeq)}`,
      signal,
    ))
    if (value === undefined) return undefined
    let header: SessionHeader
    try {
      header = headerFrom(value.header)
    } catch (error: unknown) {
      throw protocolReadError(error, 'Gateway returned an invalid session header')
    }
    if (header.id !== id) throw new SessionPersistenceReadError('protocol', 'Gateway returned a different session header')
    let events: SessionEvent[]
    try {
      events = eventsFrom(value.events)
    } catch (error: unknown) {
      throw protocolReadError(error, 'Gateway returned an invalid session event list')
    }
    return { meta: header, events }
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    const creation = isMaterialized ? undefined : this.creations.get(meta.id)
    const authorization = creation === undefined ? undefined : await creation.authorization
    await this.request('/internal/runtime/session/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: meta.id,
        batchId: deterministicBatchId('append', meta.id, events),
        events,
        ...isMaterialized ? {} : {
          ...(authorization === undefined ? { header: meta } : { creationAuthorization: authorization }),
        },
      }),
    })
    if (creation !== undefined) this.forgetCreation(meta.id, creation)
    if (!isMaterialized) {
      const draft = this.drafts.get(meta.id)
      if (draft !== undefined) await this.releaseDraft(draft.request)
    }
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (closers.length === 0) return
    await this.request('/internal/runtime/session/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: meta.id,
        batchId: deterministicBatchId('repair', meta.id, closers),
        closers,
      }),
    })
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return (await this.listSnapshots(signal)).map(snapshot => snapshot.header)
  }

  override revision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    return this.readStoredRevision(id, signal)
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const value = record(await this.request('/internal/runtime/session/list', {}, signal))
    if (!Array.isArray(value?.items)) throw new Error('Gateway returned an invalid session list')
    return value.items.map((candidate) => {
      const item = record(candidate)
      if (typeof item?.revision !== 'string' || item.revision === '') {
        throw new SessionPersistenceReadError('protocol', 'Gateway returned an invalid session list revision')
      }
      let header: SessionHeader
      try {
        header = headerFrom(item.header)
      } catch (error: unknown) {
        throw protocolReadError(error, 'Gateway returned an invalid session header')
      }
      let content: SessionContentMetadata | undefined
      try {
        content = contentMetadataFrom(item.content)
      } catch (error: unknown) {
        throw protocolReadError(error, 'Gateway returned invalid session content metadata')
      }
      return {
        header,
        revision: SessionPersistenceRevision(item.revision),
        ...(content === undefined ? {} : { content }),
      }
    })
  }
}

export default GatewaySessionPersistence
