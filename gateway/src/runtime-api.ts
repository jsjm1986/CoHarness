import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { CollaborationDeniedError } from './collaboration.ts'
import type { RuntimeTarget } from './instances.ts'
import {
  PRINCIPAL_HEADER,
  type GatewayPrincipalClaims,
  type GatewayPrincipalSigner,
  type GatewaySessionCreationClaims,
  type GatewaySessionCreationHeader,
} from './principal.ts'
import {
  ConversationEvent,
  ConversationDraftReservation,
  ConversationHeader,
  ConversationPage,
  ConversationPageRequest,
  ConversationPageTooLargeError,
  ConversationReadError,
  conversationHistoryIndexFromEvents,
  conversationEventGroupKey,
  decodePageCursor,
  encodePageCursor,
  type ConversationRepository,
  type StoredConversation,
} from './postgres/conversation-repository.ts'
import type { PostgresInstanceRepository } from './postgres/instance-repository.ts'
import type { PostgresCollaborationService } from './postgres/collaboration-service.ts'
import { internalUserId, type PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { GatewayPushService } from './push-notifications.ts'
import type { GatewayModelGovernanceService } from './services.ts'
import type { ConversationArchiveRuntimeSnapshot, ConversationArchiveService } from './postgres/conversation-archive-service.ts'
import {
  DocumentTransferError,
  type RuntimeDocumentTransferHandler,
  type RuntimeDocumentTransferCapabilitiesHandler,
  type RuntimeDocumentTransferDirectoriesHandler,
  type RuntimeDocumentTransferDirectoryCreateHandler,
  type RuntimeDocumentTransferPlanHandler,
  type RuntimeDocumentTransferListHandler,
} from './document-transfer.ts'
import {
  DocumentCatalogError,
  type RuntimeDocumentCatalogAuthorizeHandler,
  type RuntimeDocumentCatalogOverviewHandler,
  type RuntimeDocumentCatalogHistoryHandler,
  type RuntimeDocumentCatalogSyncHandler,
  type RuntimeDocumentCatalogPurgeHandler,
} from './document-catalog.ts'

export interface RuntimeCredentialSubject {
  organizationId: string
  target: RuntimeTarget
  generation: number
  userInternalId?: string
  projectInternalId?: string
}

type RuntimeSessionHeader = GatewaySessionCreationHeader

const MAX_READABLE_SESSION_IDS = 50_000
const READABLE_SESSION_BATCH_SIZE = 5_000
const MAX_ARCHIVE_SESSION_IDS = 5000
const MAX_ARCHIVE_SEARCH_ROWS = 20_000
const MAX_ARCHIVE_SEARCH_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_TEXT_BYTES = 64 * 1024
const EVENT_ENVELOPE_KEYS = new Set([
  'type',
  'seq',
  'time',
  'data',
  'surfaceOp',
  'sourceEventSeqs',
  'ignorable',
])
const SURFACE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
])

interface RuntimeApiDependencies {
  context: Pick<PostgresRuntimeContext, 'pool' | 'organizationSlug'>
  instances: Pick<PostgresInstanceRepository, 'authenticateRuntimeToken'>
  conversations: Pick<ConversationRepository, 'append' | 'listScoped' | 'load' | 'removeTree'>
    & Partial<Pick<ConversationRepository,
      'readHeader' | 'readFrom' | 'readPage' | 'readHistoryIndex' | 'revision'
      | 'reserveDraft' | 'heartbeatDraftForOwner' | 'releaseDraftForOwner'>>
  collaboration: Pick<
    PostgresCollaborationService,
    'access' | 'claimInteraction' | 'projectForUser' | 'readableSessionIds'
  >
  archives?: Pick<ConversationArchiveService, 'syncRuntimeSnapshot' | 'acknowledgeCommand'>
  principals: GatewayPrincipalSigner
  governance: Pick<GatewayModelGovernanceService, 'resolveOrganizationCredential'>
    & Partial<Pick<GatewayModelGovernanceService, 'resolveManagedCredential'>>
  /** Optional FCM delivery; omitted in keyless/unit-test compositions. */
  push?: Pick<GatewayPushService, 'notifyCompleted'>
  /** Optional cross-scope document broker; absent in standalone test compositions. */
  documentTransfer?: RuntimeDocumentTransferHandler
  /** Optional safe scope-capability projection for document-manager clients. */
  documentTransferCapabilities?: RuntimeDocumentTransferCapabilitiesHandler
  /** Optional authorized alternate-scope document listing. */
  documentTransferList?: RuntimeDocumentTransferListHandler
  documentTransferDirectories?: RuntimeDocumentTransferDirectoriesHandler
  documentTransferDirectoryCreate?: RuntimeDocumentTransferDirectoryCreateHandler
  documentTransferPlan?: RuntimeDocumentTransferPlanHandler
  /** Commit and retry deliberately share the transfer implementation; each rechecks ACLs. */
  documentTransferCommit?: RuntimeDocumentTransferHandler
  documentTransferRetry?: RuntimeDocumentTransferHandler
  /** Optional organization document metadata catalog handlers. */
  documentCatalogSync?: RuntimeDocumentCatalogSyncHandler
  documentCatalogPurge?: RuntimeDocumentCatalogPurgeHandler
  documentCatalogAuthorize?: RuntimeDocumentCatalogAuthorizeHandler
  documentCatalogOverview?: RuntimeDocumentCatalogOverviewHandler
  documentCatalogHistory?: RuntimeDocumentCatalogHistoryHandler
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function boundedOptionalString(value: unknown, maximum: number): value is string | undefined {
  return optionalString(value) && (value === undefined || Buffer.byteLength(value, 'utf8') <= maximum)
}

function surfaceOp(value: unknown): boolean {
  if (value === 'append') return true
  const operation = record(value)
  return operation !== undefined
    && Object.keys(operation).length === 3
    && operation.op === 'replace'
    && safeInteger(operation.start)
    && safeInteger(operation.end)
}

function jsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined
  } catch {
    return false
  }
}

function sessionHeader(value: unknown): RuntimeSessionHeader {
  const header = record(value)
  if (header === undefined || typeof header.id !== 'string' || header.id === '' || header.id.length > 512
    || !safeInteger(header.version) || !safeInteger(header.createdAt)
    || !boundedOptionalString(header.cwd, 4096) || !boundedOptionalString(header.parentSession, 512)
    || (header.seedLength !== undefined && !safeInteger(header.seedLength))
    || (header.origin !== undefined && header.origin !== 'subagent')
    || (header.delegationDepth !== undefined && !safeInteger(header.delegationDepth))
    || !boundedOptionalString(header.agentPreset, 256)
    || (header.draft !== undefined && typeof header.draft !== 'boolean')) {
    throw new Error('invalid session header')
  }
  return value as RuntimeSessionHeader
}

function conversationEvents(value: unknown): ConversationEvent[] {
  if (!Array.isArray(value)) throw new Error('invalid conversation event batch')
  return value.map((candidate) => {
    const event = record(candidate)
    if (event === undefined || !Object.keys(event).every(key => EVENT_ENVELOPE_KEYS.has(key))
      || !Object.hasOwn(event, 'type') || typeof event.type !== 'string' || event.type === ''
      || !Object.hasOwn(event, 'seq') || !safeInteger(event.seq)
      || !Object.hasOwn(event, 'time') || !safeInteger(event.time)
      || !Object.hasOwn(event, 'data') || !jsonSerializable(event.data)
      || (Object.hasOwn(event, 'sourceEventSeqs') && (!Array.isArray(event.sourceEventSeqs)
        || !event.sourceEventSeqs.every(seq => safeInteger(seq))))
      || (Object.hasOwn(event, 'ignorable') && event.ignorable !== true)) {
      throw new Error('invalid conversation event batch')
    }
    const isSurfaceEvent = SURFACE_EVENT_TYPES.has(event.type)
    const hasSurfaceOp = Object.hasOwn(event, 'surfaceOp')
    const hasSourceEventSeqs = Object.hasOwn(event, 'sourceEventSeqs')
    if ((isSurfaceEvent && (!hasSurfaceOp || !surfaceOp(event.surfaceOp)))
      || (!isSurfaceEvent && (hasSurfaceOp || hasSourceEventSeqs))) {
      throw new Error('invalid conversation event batch')
    }
    return candidate as ConversationEvent
  })
}

/** Reject a stored event range that would silently skip a durable sequence. */
function validateConversationRange(events: readonly ConversationEvent[], fromSeq: number): void {
  let expected = fromSeq
  for (const event of events) {
    if (event.seq !== expected) throw new ConversationReadError('protocol', 'conversation event range is not contiguous')
    expected += 1
  }
}

/** Validate bounded navigation metadata before it crosses the runtime wire. */
function validateHistoryIndex(value: {
  readonly asOfSeq: number
  readonly totalTurns: number
  readonly items: readonly {
    readonly turn: number
    readonly startSeq: number
    readonly endSeq: number
    readonly prompt?: string
    readonly response?: string
  }[]
  readonly truncated: boolean
}, maxItems: number): void {
  if (!safeInteger(value.asOfSeq, -1) || !safeInteger(value.totalTurns)
    || value.items.length > maxItems || value.items.length > value.totalTurns
    || typeof value.truncated !== 'boolean') {
    throw new ConversationReadError('protocol', 'conversation history index metadata is invalid')
  }
  let previousTurn = -1
  let previousEnd = -1
  for (const item of value.items) {
    const previewValid = (text: string | undefined): boolean => text === undefined || Array.from(text).length <= 160
    if (!safeInteger(item.turn) || !safeInteger(item.startSeq) || !safeInteger(item.endSeq)
      || item.startSeq > item.endSeq || item.turn <= previousTurn || item.startSeq <= previousEnd
      || (value.asOfSeq >= 0 && item.endSeq > value.asOfSeq)
      || !previewValid(item.prompt) || !previewValid(item.response)) {
      throw new ConversationReadError('protocol', 'conversation history index item is invalid')
    }
    previousTurn = item.turn
    previousEnd = item.endSeq
  }
}

function completedTurnEndSeqs(events: readonly ConversationEvent[]): number[] {
  return events.filter((event) => {
    if (event.type !== 'turn/end') return false
    const data = record(event.data)
    const reason = record(data?.reason)
    return reason?.kind === 'completed'
  }).map(event => event.seq)
}

function runtimeHeader(header: ConversationHeader): RuntimeSessionHeader {
  return {
    id: header.id,
    version: header.sessionFormatVersion,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSessionId === undefined ? {} : { parentSession: header.parentSessionId }),
    ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
    ...(header.origin === undefined ? {} : { origin: header.origin as 'subagent' }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    ...(header.draft === undefined ? {} : { draft: header.draft }),
  }
}

function assertionHeader(req: IncomingMessage): string | undefined {
  const value = req.headers[PRINCIPAL_HEADER]
  return typeof value === 'string' ? value : undefined
}

function authorizationToken(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined
  const token = value.slice('Bearer '.length)
  return token === '' ? undefined : token
}

/** Request-local signal disposers; the outer handler drains these on every exit path. */
const requestSignalDisposers = new WeakMap<ServerResponse, Set<() => void>>()

interface RequestEventSource {
  once?: (event: string, listener: () => void) => unknown
  removeListener?: (event: string, listener: () => void) => unknown
}

function disposeRequestSignals(res: ServerResponse): void {
  const disposers = requestSignalDisposers.get(res)
  if (disposers === undefined) return
  for (const dispose of [...disposers]) dispose()
}

/** Abort a broker operation when either side of the loopback request closes. */
function requestSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  const requestEvents = req as unknown as RequestEventSource
  const responseEvents = res as unknown as RequestEventSource
  let disposed = false
  const onRequestAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('runtime request aborted'))
    dispose()
  }
  const onRequestClose = (): void => {
    // A normal request emits `close` after its body has been fully parsed;
    // only an incomplete request indicates a transport disconnect here.
    if (req.complete === false) onRequestAbort()
    else requestEvents.removeListener?.('close', onRequestClose)
  }
  const onResponseClose = (): void => {
    if (!res.writableEnded) onRequestAbort()
    else dispose()
  }
  const onResponseFinish = (): void => { dispose() }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    requestEvents.removeListener?.('aborted', onRequestAbort)
    requestEvents.removeListener?.('close', onRequestClose)
    responseEvents.removeListener?.('close', onResponseClose)
    responseEvents.removeListener?.('finish', onResponseFinish)
    const disposers = requestSignalDisposers.get(res)
    if (disposers === undefined) return
    disposers.delete(dispose)
    if (disposers.size === 0) requestSignalDisposers.delete(res)
  }
  requestEvents.once?.('aborted', onRequestAbort)
  requestEvents.once?.('close', onRequestClose)
  responseEvents.once?.('close', onResponseClose)
  responseEvents.once?.('finish', onResponseFinish)
  let disposers = requestSignalDisposers.get(res)
  if (disposers === undefined) {
    disposers = new Set()
    requestSignalDisposers.set(res, disposers)
  }
  disposers.add(dispose)
  return controller.signal
}

function assertionFor(
  req: IncomingMessage,
  authority: GatewayPrincipalSigner,
  subject: RuntimeCredentialSubject,
  required: boolean,
  options: { readonly allowDocumentAdmin?: boolean } = {},
): GatewayPrincipalClaims | undefined {
  const assertion = assertionHeader(req)
  if (assertion === undefined) {
    if (required) throw new CollaborationDeniedError('forbidden')
    return undefined
  }
  const claims = authority.verify(assertion)
  if (claims.runtime.kind !== subject.target.kind || claims.runtime.id !== subject.target.id
    || claims.runtime.generation !== subject.generation) {
    throw new CollaborationDeniedError('forbidden')
  }
  if (subject.target.kind === 'user') {
    const documentAdmin = options.allowDocumentAdmin === true && claims.purpose === 'document-admin'
      && claims.user.role === 'admin'
    if (claims.scope.kind !== 'personal' || (claims.user.id !== subject.target.id && !documentAdmin)) {
      throw new CollaborationDeniedError('forbidden')
    }
  } else if (claims.scope.kind !== 'project' || claims.scope.projectId !== subject.target.id) {
    throw new CollaborationDeniedError('forbidden')
  }
  return claims
}

function belongsToRuntime(header: ConversationHeader, subject: RuntimeCredentialSubject): boolean {
  if (header.organizationId !== subject.organizationId) return false
  if (subject.target.kind === 'user') {
    return header.projectId === undefined && header.creatorUserId === subject.userInternalId
  }
  return header.projectId === subject.projectInternalId
}

function revisionFor(subject: RuntimeCredentialSubject, revision: string): string {
  return `postgres:${subject.organizationId}:${subject.target.kind}:${String(subject.target.id)}:${revision}`
}

function draftScopeKey(
  subject: RuntimeCredentialSubject,
  claims: GatewayPrincipalClaims,
  cwd: string,
  visibility: 'personal' | 'project' | 'private',
  agentPreset: string | undefined,
): string {
  const owner = subject.target.kind === 'user'
    ? { kind: 'personal', runtime: subject.target.id, user: claims.user.id }
    : { kind: 'project', runtime: subject.target.id, project: claims.scope.kind === 'project' ? claims.scope.projectId : 0, user: claims.user.id }
  return createHash('sha256').update(JSON.stringify({ owner, cwd, visibility, agentPreset: agentPreset ?? '' })).digest('hex')
}

/** Authenticated loopback API used by Gateway-backed runtime plugins. */
export function createRuntimeApiHandler(
  deps: RuntimeApiDependencies,
): (req: IncomingMessage, res: ServerResponse, pathname: string, body: string) => Promise<boolean> {
  const authenticate = async (req: IncomingMessage): Promise<RuntimeCredentialSubject | null> => {
    const token = authorizationToken(req)
    return token === undefined ? null : deps.instances.authenticateRuntimeToken(token)
  }

  const stored = async (sessionId: string, subject: RuntimeCredentialSubject): Promise<StoredConversation | undefined> => {
    const value = await deps.conversations.load(sessionId)
    return value !== undefined && belongsToRuntime(value.header, subject) ? value : undefined
  }

  /** Read only the metadata required to authorize a session operation. */
  const storedHeader = async (
    sessionId: string,
    subject: RuntimeCredentialSubject,
    signal?: AbortSignal,
  ): Promise<ConversationHeader | undefined> => {
    const value = deps.conversations.readHeader !== undefined
      ? await deps.conversations.readHeader(sessionId, signal)
      : (await deps.conversations.load(sessionId))?.header
    return value !== undefined && belongsToRuntime(value, subject) ? value : undefined
  }

  /** Compatibility page fallback for test/third-party repositories without a seek primitive. */
  const fallbackPage = async (
    sessionId: string,
    subject: RuntimeCredentialSubject,
    request: ConversationPageRequest,
    signal: AbortSignal,
  ): Promise<ConversationPage | undefined> => {
    const value = await stored(sessionId, subject)
    signal.throwIfAborted()
    if (value === undefined) return undefined
    const cursor = request.cursor === undefined ? undefined : decodePageCursor(request.cursor)
    const direction = request.direction
      ?? cursor?.direction
      ?? (request.beforeSeq !== undefined ? 'older' : request.fromSeq !== undefined ? 'newer' : 'older')
    if (direction !== 'older' && direction !== 'newer') {
      throw new ConversationReadError('protocol', 'conversation page direction is invalid')
    }
    if (cursor !== undefined && (cursor.sessionId !== sessionId || cursor.direction !== direction)) {
      throw new ConversationReadError('protocol', 'conversation page cursor belongs to another request')
    }
    // A moved log is the same transient condition as a revision change inside
    // one page read; the Host retries `dependency`, never `protocol`.
    if (cursor !== undefined && cursor.revision !== value.revision) {
      throw new ConversationReadError('dependency', 'conversation revision changed since the page cursor was issued')
    }
    if (request.cursor !== undefined && (request.beforeSeq !== undefined || request.fromSeq !== undefined)) {
      throw new ConversationReadError('protocol', 'conversation page cursor cannot be combined with a sequence anchor')
    }
    if (direction === 'older' && request.fromSeq !== undefined) {
      throw new ConversationReadError('protocol', 'older conversation pages cannot use fromSeq')
    }
    if (direction === 'newer' && request.beforeSeq !== undefined) {
      throw new ConversationReadError('protocol', 'newer conversation pages cannot use beforeSeq')
    }
    const maxEvents = request.maxEvents ?? 2_000
    const maxBytes = request.maxBytes ?? 512 * 1024
    const maxGroups = request.maxGroups ?? 50
    if (!safeInteger(maxEvents) || maxEvents < 1 || maxEvents > 2_000
      || !safeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024
      || !safeInteger(maxGroups) || maxGroups < 1 || maxGroups > 50) {
      throw new ConversationReadError('protocol', 'invalid conversation page limits')
    }
    const tailSeq = value.events.at(-1)?.seq
    const anchor = cursor?.anchor ?? (direction === 'older'
      ? request.beforeSeq ?? (tailSeq === undefined ? 0 : tailSeq + 1)
      : request.fromSeq ?? 0)
    const window = direction === 'older'
      ? value.events.filter(event => event.seq < anchor)
      : value.events.filter(event => event.seq >= anchor)
    const selected: ConversationEvent[] = []
    const groups = new Set<string>()
    let bytes = 0
    const start = direction === 'older' ? window.length - 1 : 0
    const step = direction === 'older' ? -1 : 1
    for (let index = start; index >= 0 && index < window.length; index += step) {
      const event = window[index]!
      const encoded = JSON.stringify(event)
      if (encoded === undefined) throw new ConversationReadError('protocol', 'conversation event is not JSON serializable')
      const size = Buffer.byteLength(encoded, 'utf8')
      if (selected.length === 0 && size > maxBytes) throw new ConversationPageTooLargeError(size, maxBytes)
      const group = conversationEventGroupKey(event)
      if (selected.length >= maxEvents || bytes + size > maxBytes
        || (!groups.has(group) && groups.size >= maxGroups)) break
      selected.push(event)
      groups.add(group)
      bytes += size
    }
    const events = direction === 'older' ? selected.reverse() : selected
    const first = events[0]
    const last = events.at(-1)
    const hasMore = selected.length < window.length
    const nextAnchor = direction === 'older'
      ? (first?.seq ?? anchor)
      : (last?.seq === undefined ? anchor : last.seq + 1)
    return {
      header: value.header,
      events,
      revision: value.revision,
      startSeq: first?.seq ?? null,
      endSeq: last?.seq ?? null,
      hasMore,
      ...(hasMore ? { nextCursor: encodePageCursor({ version: 1, sessionId, revision: value.revision, direction, anchor: nextAnchor }) } : {}),
      uncompressedBytes: bytes,
    }
  }

  const createHeader = async (
    req: IncomingMessage,
    subject: RuntimeCredentialSubject,
    header: RuntimeSessionHeader,
    visibility: unknown,
  ): Promise<ConversationHeader> => {
    if (visibility !== undefined && visibility !== 'project' && visibility !== 'private') {
      throw new Error('invalid conversation visibility')
    }
    let creatorUserId = subject.userInternalId
    if (subject.target.kind === 'project') {
      if (header.parentSession === undefined) throw new CollaborationDeniedError('forbidden')
      assertionFor(req, deps.principals, subject, false)
      creatorUserId = undefined
    } else {
      assertionFor(req, deps.principals, subject, false)
    }
    return {
      id: header.id,
      organizationId: subject.organizationId,
      ...(creatorUserId === undefined ? {} : { creatorUserId }),
      ...(subject.projectInternalId === undefined ? {} : { projectId: subject.projectInternalId }),
      ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
      ...(subject.target.kind === 'project'
        ? { visibility: (visibility ?? 'project') as 'project' | 'private' }
        : { visibility: 'personal' as const }),
      sessionFormatVersion: header.version,
      createdAt: header.createdAt,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
      ...(header.draft === undefined ? {} : { draft: header.draft }),
    }
  }

  const verifyCreation = (
    authorization: string,
    subject: RuntimeCredentialSubject,
    sessionId: string,
  ): GatewaySessionCreationClaims => {
    const claims = deps.principals.verifySessionCreation(authorization)
    if (subject.target.kind !== 'project' || subject.projectInternalId === undefined
      || claims.organization !== deps.context.organizationSlug
      || claims.runtime.kind !== subject.target.kind || claims.runtime.id !== subject.target.id
      || claims.runtime.generation !== subject.generation) {
      throw new Error('invalid session creation authorization')
    }
    if (claims.header.id !== sessionId || claims.header.parentSession !== undefined) {
      throw new Error('invalid session creation authorization')
    }
    return claims
  }

  const creationHeader = async (
    authorization: string,
    subject: RuntimeCredentialSubject,
    sessionId: string,
  ): Promise<ConversationHeader> => {
    const claims = verifyCreation(authorization, subject, sessionId)
    const membership = await deps.collaboration.projectForUser(subject.target.id, claims.creatorUserId)
    if (membership === null || membership.mode !== 'rw') throw new CollaborationDeniedError('forbidden')
    const creatorUserId = await internalUserId(
      deps.context.pool,
      subject.organizationId,
      claims.creatorUserId,
    )
    if (creatorUserId === null) throw new CollaborationDeniedError('forbidden')
    return {
      id: claims.header.id,
      organizationId: subject.organizationId,
      creatorUserId,
      projectId: subject.projectInternalId,
      visibility: claims.visibility,
      sessionFormatVersion: claims.header.version,
      createdAt: claims.header.createdAt,
      ...(claims.header.cwd === undefined ? {} : { cwd: claims.header.cwd }),
      ...(claims.header.seedLength === undefined ? {} : { seedLength: claims.header.seedLength }),
      ...(claims.header.origin === undefined ? {} : { origin: claims.header.origin }),
      ...(claims.header.delegationDepth === undefined
        ? {} : { delegationDepth: claims.header.delegationDepth }),
      ...(claims.header.agentPreset === undefined ? {} : { agentPreset: claims.header.agentPreset }),
      ...(claims.header.draft === undefined ? {} : { draft: claims.header.draft }),
    }
  }

  const creationAccess = async (
    authorization: string,
    subject: RuntimeCredentialSubject,
    actor: GatewayPrincipalClaims,
    sessionId: string,
    action: 'read' | 'write' | 'manage' | 'approve',
  ) => {
    const claims = verifyCreation(authorization, subject, sessionId)
    const membership = await deps.collaboration.projectForUser(subject.target.id, actor.user.id)
    if (membership === null) throw new CollaborationDeniedError('not-member')
    const isCreator = actor.user.id === claims.creatorUserId
    const canRead = membership.administrator || claims.visibility === 'project' || isCreator
    const canWrite = membership.mode === 'rw' && canRead
    const canManage = membership.mode === 'rw' && (membership.administrator || isCreator)
    if (!canRead || (action === 'write' && !canWrite) || (action === 'approve' && !canWrite)
      || (action === 'manage' && !canManage)) {
      throw new CollaborationDeniedError('forbidden')
    }
    return {
      sessionId,
      rootSessionId: sessionId,
      projectId: subject.target.id,
      visibility: claims.visibility,
      creatorUserId: claims.creatorUserId,
      mode: membership.mode,
      canRead: true as const,
      canWrite,
      canManage,
    }
  }

  return async (req, res, pathname, body) => {
    if (!pathname.startsWith('/internal/runtime/')) return false
    const subject = await authenticate(req)
    if (subject === null) {
      send(res, 401, { error: 'invalid-runtime-token' })
      return true
    }
    try {
      const url = new URL(req.url ?? '/', 'http://runtime')
      if (pathname === '/internal/runtime/model-credential' && req.method === 'POST') {
        const payload = record(JSON.parse(body))
        const ref = payload?.ref
        if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
          throw new Error('invalid managed credential reference')
        }
        const value = deps.governance.resolveManagedCredential !== undefined
          ? await deps.governance.resolveManagedCredential(subject.target, ref)
          : await deps.governance.resolveOrganizationCredential(subject.target, ref)
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value === null ? { configured: false } : { configured: true, value }))
        return true
      }

      if (pathname === '/internal/runtime/documents/transfer' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        if (deps.documentTransfer === undefined) {
          send(res, 503, { error: 'document-transfer-unavailable' })
          return true
        }
        const result = await deps.documentTransfer({
          request: req,
          subject,
          principal: claims,
          payload: JSON.parse(body),
          signal: requestSignal(req, res),
        })
        send(res, 200, result)
        return true
      }

      if ((pathname === '/internal/runtime/documents/transfer/commit' || pathname === '/internal/runtime/documents/transfer/retry')
        && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        const handler = pathname.endsWith('/retry') ? deps.documentTransferRetry : deps.documentTransferCommit
        if (handler === undefined) {
          send(res, 503, { error: 'document-transfer-unavailable' })
          return true
        }
        send(res, 200, await handler({
          request: req, subject, principal: claims, payload: JSON.parse(body), signal: requestSignal(req, res),
        }))
        return true
      }

      if (pathname === '/internal/runtime/documents/transfer/plan' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        if (deps.documentTransferPlan === undefined) {
          send(res, 503, { error: 'document-transfer-unavailable' })
          return true
        }
        send(res, 200, await deps.documentTransferPlan({
          subject, principal: claims, payload: JSON.parse(body), signal: requestSignal(req, res),
        }))
        return true
      }

      if (pathname === '/internal/runtime/documents/transfer/capabilities' && req.method === 'GET') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        if (deps.documentTransferCapabilities === undefined) {
          send(res, 503, { error: 'document-transfer-unavailable' })
          return true
        }
        send(res, 200, await deps.documentTransferCapabilities({
          subject, principal: claims, signal: requestSignal(req, res),
        }))
        return true
      }

      if (pathname === '/internal/runtime/documents/transfer/list' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        if (deps.documentTransferList === undefined) {
          send(res, 503, { error: 'document-transfer-unavailable' })
          return true
        }
        send(res, 200, await deps.documentTransferList({
          subject,
          principal: claims,
          payload: JSON.parse(body),
          signal: requestSignal(req, res),
        }))
        return true
      }

      if (pathname === '/internal/runtime/documents/transfer/directories' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        if (deps.documentTransferDirectories === undefined) {
          send(res, 503, { error: 'document-transfer-unavailable' })
          return true
        }
        send(res, 200, await deps.documentTransferDirectories({
          subject, principal: claims, payload: JSON.parse(body), signal: requestSignal(req, res),
        }))
        return true
      }

      if (pathname === '/internal/runtime/documents/transfer/directories/create' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        if (deps.documentTransferDirectoryCreate === undefined) {
          send(res, 503, { error: 'document-transfer-unavailable' })
          return true
        }
        send(res, 201, await deps.documentTransferDirectoryCreate({
          subject, principal: claims, payload: JSON.parse(body), signal: requestSignal(req, res),
        }))
        return true
      }

      if (pathname === '/internal/runtime/documents/catalog/sync' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true, { allowDocumentAdmin: true })!
        if (deps.documentCatalogSync === undefined) {
          send(res, 503, { error: 'document-catalog-unavailable' })
          return true
        }
        send(res, 200, await deps.documentCatalogSync({ subject, principal: claims, payload: JSON.parse(body) }))
        return true
      }

      if (pathname === '/internal/runtime/documents/catalog/authorize' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true, { allowDocumentAdmin: true })!
        if (deps.documentCatalogAuthorize === undefined) {
          send(res, 503, { error: 'document-catalog-unavailable' })
          return true
        }
        send(res, 200, await deps.documentCatalogAuthorize({ subject, principal: claims, payload: JSON.parse(body) }))
        return true
      }

      if (pathname === '/internal/runtime/documents/catalog/purge' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true, { allowDocumentAdmin: true })!
        if (deps.documentCatalogPurge === undefined) {
          send(res, 503, { error: 'document-catalog-unavailable' })
          return true
        }
        send(res, 200, await deps.documentCatalogPurge({ subject, principal: claims, payload: JSON.parse(body) }))
        return true
      }

      if (pathname === '/internal/runtime/documents/catalog/overview' && req.method === 'GET') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        if (deps.documentCatalogOverview === undefined) {
          send(res, 503, { error: 'document-catalog-unavailable' })
          return true
        }
        const query = new URL(req.url ?? pathname, 'http://runtime').searchParams
        const options: Record<string, unknown> = {}
        for (const key of ['query', 'type', 'sort', 'cursor'] as const) {
          const value = query.get(key)
          if (value !== null) options[key] = value
        }
        const limit = query.get('limit')
        if (limit !== null) options.limit = Number(limit)
        send(res, 200, await deps.documentCatalogOverview({ subject, principal: claims, options }))
        return true
      }

      if (pathname === '/internal/runtime/documents/catalog/history' && req.method === 'GET') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        if (deps.documentCatalogHistory === undefined) {
          send(res, 503, { error: 'document-catalog-unavailable' })
          return true
        }
        send(res, 200, await deps.documentCatalogHistory({ subject, principal: claims }))
        return true
      }

      if (pathname === '/internal/runtime/session/create' && req.method === 'POST') {
        const payload = record(JSON.parse(body))
        const header = sessionHeader(payload?.header)
        if (subject.target.kind !== 'project' || header.parentSession !== undefined
          || (payload?.visibility !== undefined
            && payload.visibility !== 'project' && payload.visibility !== 'private')) {
          throw new Error('invalid session creation request')
        }
        const claims = assertionFor(req, deps.principals, subject, true)!
        const membership = await deps.collaboration.projectForUser(subject.target.id, claims.user.id)
        if (membership === null || membership.mode !== 'rw'
          || await internalUserId(deps.context.pool, subject.organizationId, claims.user.id) === null) {
          throw new CollaborationDeniedError('forbidden')
        }
        send(res, 200, {
          authorization: deps.principals.issueSessionCreation({
            creatorUserId: claims.user.id,
            runtime: { kind: 'project', id: subject.target.id, generation: subject.generation },
            header,
            visibility: (payload?.visibility ?? 'project') as 'project' | 'private',
          }),
        })
        return true
      }

      if (pathname === '/internal/runtime/session/draft/reserve' && req.method === 'POST') {
        if (deps.conversations.reserveDraft === undefined) {
          send(res, 503, { error: 'draft-reservation-unavailable' })
          return true
        }
        const payload = record(JSON.parse(body))
        if (typeof payload?.draftId !== 'string' || payload.draftId.length === 0 || payload.draftId.length > 256
          || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0 || payload.sessionId.length > 256
          || typeof payload.cwd !== 'string' || payload.cwd.length === 0 || payload.cwd.length > 4096
          || (payload.visibility !== 'personal' && payload.visibility !== 'project' && payload.visibility !== 'private')
          || (payload.agentPreset !== undefined && (typeof payload.agentPreset !== 'string' || payload.agentPreset.length > 256))) {
          throw new Error('invalid draft reservation request')
        }
        const claims = assertionFor(req, deps.principals, subject, true)!
        const visibility = payload.visibility as 'personal' | 'project' | 'private'
        let userId: string | undefined
        let projectId: string | undefined
        if (subject.target.kind === 'user') {
          if (visibility !== 'personal' || subject.userInternalId === undefined || claims.scope.kind !== 'personal') {
            throw new CollaborationDeniedError('forbidden')
          }
          userId = subject.userInternalId
        } else {
          if (visibility === 'personal' || subject.projectInternalId === undefined || claims.scope.kind !== 'project') {
            throw new CollaborationDeniedError('forbidden')
          }
          const membership = await deps.collaboration.projectForUser(subject.target.id, claims.user.id)
          if (membership === null || membership.mode !== 'rw') throw new CollaborationDeniedError('forbidden')
          userId = await internalUserId(deps.context.pool, subject.organizationId, claims.user.id) ?? undefined
          if (userId === undefined) throw new CollaborationDeniedError('forbidden')
          projectId = subject.projectInternalId
        }
        const reservation: ConversationDraftReservation = await deps.conversations.reserveDraft({
          organizationId: subject.organizationId,
          scopeKey: draftScopeKey(subject, claims, payload.cwd, visibility, payload.agentPreset as string | undefined),
          draftId: payload.draftId,
          sessionId: payload.sessionId,
          ...(userId === undefined ? {} : { userId }),
          ...(projectId === undefined ? {} : { projectId }),
          cwd: payload.cwd,
          visibility,
          ...(payload.agentPreset === undefined ? {} : { agentPreset: payload.agentPreset }),
        })
        send(res, 200, {
          draftId: reservation.draftId,
          sessionId: reservation.sessionId,
          leaseExpiresAt: reservation.leaseExpiresAt,
        })
        return true
      }

      if ((pathname === '/internal/runtime/session/draft/heartbeat'
        || pathname === '/internal/runtime/session/draft/release') && req.method === 'POST') {
        if (deps.conversations.heartbeatDraftForOwner === undefined
          || deps.conversations.releaseDraftForOwner === undefined) {
          send(res, 503, { error: 'draft-reservation-unavailable' })
          return true
        }
        const payload = record(JSON.parse(body))
        if (typeof payload?.draftId !== 'string' || payload.draftId.length === 0
          || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
          throw new Error('invalid draft reservation lifecycle request')
        }
        const claims = assertionFor(req, deps.principals, subject, pathname.endsWith('/heartbeat'))
        let userId: string | undefined
        let projectId: string | undefined
        if (subject.target.kind === 'user') {
          if (subject.userInternalId === undefined
            || (claims !== undefined && claims.scope.kind !== 'personal')) {
            throw new CollaborationDeniedError('forbidden')
          }
          userId = subject.userInternalId
        } else {
          if (subject.projectInternalId === undefined
            || (claims !== undefined && claims.scope.kind !== 'project')) {
            throw new CollaborationDeniedError('forbidden')
          }
          if (claims !== undefined) {
            const membership = await deps.collaboration.projectForUser(subject.target.id, claims.user.id)
            if (membership === null || membership.mode !== 'rw') throw new CollaborationDeniedError('forbidden')
          }
          projectId = subject.projectInternalId
        }
        const input = {
          organizationId: subject.organizationId,
          draftId: payload.draftId,
          sessionId: payload.sessionId,
          ...(userId === undefined ? {} : { userId }),
          ...(projectId === undefined ? {} : { projectId }),
        }
        if (pathname.endsWith('/heartbeat')) {
          const renewed = await deps.conversations.heartbeatDraftForOwner(input)
          send(res, 200, { renewed })
        } else {
          await deps.conversations.releaseDraftForOwner(input)
          send(res, 200, { released: true })
        }
        return true
      }

      if (pathname === '/internal/runtime/archive/snapshot' && req.method === 'POST') {
        if (deps.archives === undefined) {
          send(res, 503, { error: 'conversation-archive-unavailable' })
          return true
        }
        const payload = record(JSON.parse(body))
        const revision = payload?.revision
        const ids = payload?.archivedSessionIds
        const sessions = payload?.sessions
        const searchPayload = payload?.search
        if (!safeInteger(revision) || revision < 0 || !Array.isArray(ids)
          || ids.length > MAX_ARCHIVE_SESSION_IDS
          || new Set(ids).size !== ids.length
          || !ids.every(id => typeof id === 'string' && id !== '' && id.length <= 512)
          || !Array.isArray(sessions) || sessions.length > 5000
          || (searchPayload !== undefined && (!Array.isArray(searchPayload) || searchPayload.length > MAX_ARCHIVE_SEARCH_ROWS))) {
          throw new Error('invalid archive snapshot')
        }
        const sessionIds = new Set<string>()
        let searchBytes = 0
        const snapshot = {
          runtime: { kind: subject.target.kind, id: subject.target.id },
          revision,
          archivedSessionIds: ids as string[],
          sessions: sessions.map(value => {
            const item = record(value)
            const header = record(item?.header)
            const workspace = record(item?.workspace)
            if (typeof item?.sessionId !== 'string' || item.sessionId === '' || item.sessionId.length > 512
              || sessionIds.has(item.sessionId) || header === undefined
              || (item.rootSessionId !== undefined && (typeof item.rootSessionId !== 'string' || item.rootSessionId === '' || item.rootSessionId.length > 512))
              || (item.messageCount !== undefined && (!safeInteger(item.messageCount) || item.messageCount > 1_000_000))
              || (item.rootMessageCount !== undefined && !safeInteger(item.rootMessageCount))
              || (item.title !== undefined && !boundedOptionalString(item.title, MAX_ARCHIVE_TEXT_BYTES))
              || (header.createdAt !== undefined && !safeInteger(header.createdAt))
              || !boundedOptionalString(header.cwd, 4096)
              || (header.parentSession !== undefined && (typeof header.parentSession !== 'string' || header.parentSession === '' || header.parentSession.length > 512))
              || !boundedOptionalString(header.agentPreset, 256)
              || (header.draft !== undefined && typeof header.draft !== 'boolean')
              || (workspace !== undefined && (typeof workspace.path !== 'string' || workspace.path === '' || Buffer.byteLength(workspace.path, 'utf8') > 4096
                || typeof workspace.title !== 'string' || workspace.title === '' || Buffer.byteLength(workspace.title, 'utf8') > MAX_ARCHIVE_TEXT_BYTES
                || !safeInteger(workspace.position))) ) {
              throw new Error('invalid archive session snapshot')
            }
            sessionIds.add(item.sessionId)
            return {
              sessionId: item.sessionId,
              ...(typeof item.rootSessionId === 'string' && item.rootSessionId !== '' ? { rootSessionId: item.rootSessionId } : {}),
              header: {
                ...(typeof header.createdAt === 'number' ? { createdAt: header.createdAt } : {}),
                ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
                ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
                ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
                ...(typeof header.draft === 'boolean' ? { draft: header.draft } : {}),
              },
              ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}),
              ...(safeInteger(item.messageCount) ? { messageCount: item.messageCount } : {}),
              ...(safeInteger(item.rootMessageCount) ? { rootMessageCount: item.rootMessageCount } : {}),
              ...(workspace === undefined ? {} : {
                workspace: {
                  path: workspace.path as string,
                  title: workspace.title as string,
                  position: workspace.position as number,
                },
              }),
            }
          }),
          ...(searchPayload === undefined ? {} : {
            search: searchPayload.map((candidate) => {
              const item = record(candidate)
              if (item === undefined || typeof item.sessionId !== 'string' || !sessionIds.has(item.sessionId)
                || !safeInteger(item.seq) || typeof item.role !== 'string'
                || (item.role !== 'user' && item.role !== 'assistant')
                || typeof item.content !== 'string' || Buffer.byteLength(item.content, 'utf8') > MAX_ARCHIVE_TEXT_BYTES
                || !safeInteger(item.occurredAt)) {
                throw new Error('invalid archive search row')
              }
              searchBytes += Buffer.byteLength(item.content, 'utf8')
              if (searchBytes > MAX_ARCHIVE_SEARCH_TOTAL_BYTES) throw new Error('archive search payload is too large')
              return {
                sessionId: item.sessionId,
                seq: item.seq,
                role: item.role,
                content: item.content,
                occurredAt: item.occurredAt,
              }
            }),
          }),
        } satisfies ConversationArchiveRuntimeSnapshot
        const commands = await deps.archives.syncRuntimeSnapshot(snapshot, {
          kind: subject.target.kind,
          id: subject.target.id,
        })
        send(res, 200, { commands })
        return true
      }

      if (pathname === '/internal/runtime/archive/ack' && req.method === 'POST') {
        if (deps.archives === undefined) {
          send(res, 503, { error: 'conversation-archive-unavailable' })
          return true
        }
        const payload = record(JSON.parse(body))
        if (typeof payload?.commandId !== 'string' || !safeInteger(payload.revision) || payload.revision < 0
          || (payload.error !== undefined && typeof payload.error !== 'string')) {
          throw new Error('invalid archive acknowledgement')
        }
        await deps.archives.acknowledgeCommand(payload.commandId, payload.revision, payload.error as string | undefined, {
          kind: subject.target.kind,
          id: subject.target.id,
        })
        send(res, 200, { acknowledged: true })
        return true
      }

      if (pathname === '/internal/runtime/session/append' && req.method === 'POST') {
        const payload = record(JSON.parse(body))
        if (typeof payload?.sessionId !== 'string' || typeof payload.batchId !== 'string') {
          throw new Error('invalid append request')
        }
        const header = payload.header === undefined ? undefined : sessionHeader(payload.header)
        const creationAuthorization = payload.creationAuthorization
        if ((creationAuthorization !== undefined && (typeof creationAuthorization !== 'string'
          || creationAuthorization === '')) || (header !== undefined && creationAuthorization !== undefined)
          || (header !== undefined && header.id !== payload.sessionId)) {
          throw new Error('invalid append request')
        }
        if (header === undefined && creationAuthorization === undefined
          && await storedHeader(payload.sessionId, subject, requestSignal(req, res)) === undefined) {
          throw new CollaborationDeniedError('conversation-not-found')
        }
        const materialization = creationAuthorization === undefined
          ? (header === undefined ? undefined : await createHeader(req, subject, header, payload.visibility))
          : await creationHeader(creationAuthorization, subject, payload.sessionId)
        const events = conversationEvents(payload.events)
        const result = await deps.conversations.append(
          payload.sessionId,
          payload.batchId,
          events,
          materialization,
        )
        if (result === 'inserted' && deps.push !== undefined) {
          const completed = completedTurnEndSeqs(events)
          for (const eventSeq of completed) {
            void deps.push.notifyCompleted(payload.sessionId, eventSeq).catch((error: unknown) => {
              console.error(`[gateway] completed-turn push failed for ${payload.sessionId}:`, error)
            })
          }
        }
        send(res, 200, { result })
        return true
      }

      if (pathname === '/internal/runtime/session/load' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const value = await stored(sessionId, subject)
        if (value === undefined) throw new CollaborationDeniedError('conversation-not-found')
        send(res, 200, {
          header: runtimeHeader(value.header),
          events: value.events,
          revision: revisionFor(subject, value.revision),
        })
        return true
      }

      if (pathname === '/internal/runtime/session/read-from' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const fromSeq = Number(url.searchParams.get('fromSeq'))
        if (!safeInteger(fromSeq)) throw new Error('invalid fromSeq')
        const signal = requestSignal(req, res)
        const header = await storedHeader(sessionId, subject, signal)
        if (header === undefined) throw new CollaborationDeniedError('conversation-not-found')
        const events = deps.conversations.readFrom !== undefined
          ? await deps.conversations.readFrom(sessionId, fromSeq, signal)
          : (await stored(sessionId, subject))?.events.filter(event => event.seq >= fromSeq) ?? []
        validateConversationRange(events, fromSeq)
        send(res, 200, {
          header: runtimeHeader(header),
          events,
        })
        return true
      }

      if (pathname === '/internal/runtime/session/meta' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const signal = requestSignal(req, res)
        const header = await storedHeader(sessionId, subject, signal)
        if (header === undefined) throw new CollaborationDeniedError('conversation-not-found')
        const revision = deps.conversations.revision !== undefined
          ? await deps.conversations.revision(sessionId, signal)
          : (await stored(sessionId, subject))?.revision
        if (revision === undefined) throw new CollaborationDeniedError('conversation-not-found')
        send(res, 200, {
          header: runtimeHeader(header),
          revision: revisionFor(subject, revision),
        })
        return true
      }

      if (pathname === '/internal/runtime/session/index' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const rawMaxItems = url.searchParams.get('maxItems')
        const maxItems = rawMaxItems === null ? 2_000 : Number(rawMaxItems)
        if (!safeInteger(maxItems) || maxItems < 1 || maxItems > 2_000) {
          throw new ConversationReadError('protocol', 'invalid conversation history index maxItems')
        }
        const signal = requestSignal(req, res)
        const header = await storedHeader(sessionId, subject, signal)
        if (header === undefined) throw new CollaborationDeniedError('conversation-not-found')
        const indexed = deps.conversations.readHistoryIndex === undefined
          ? undefined
          : await deps.conversations.readHistoryIndex(sessionId, maxItems, signal)
        if (indexed === undefined) {
          // Compatibility repositories without a bounded index retain their
          // existing complete-read fallback; first-party PostgreSQL never
          // reaches this branch.
          const value = await stored(sessionId, subject)
          if (value === undefined) throw new CollaborationDeniedError('conversation-not-found')
          const fallback = conversationHistoryIndexFromEvents(value.events, value.revision, maxItems)
          send(res, 200, {
            header: runtimeHeader(header),
            revision: revisionFor(subject, fallback.revision),
            asOfSeq: fallback.asOfSeq,
            totalTurns: fallback.totalTurns,
            items: fallback.items,
            truncated: fallback.truncated,
          })
          return true
        }
        if (typeof indexed.revision !== 'string' || indexed.revision === '') {
          throw new ConversationReadError('protocol', 'conversation history index revision is invalid')
        }
        validateHistoryIndex(indexed, maxItems)
        send(res, 200, {
          header: runtimeHeader(header),
          revision: revisionFor(subject, indexed.revision),
          asOfSeq: indexed.asOfSeq,
          totalTurns: indexed.totalTurns,
          items: indexed.items,
          truncated: indexed.truncated,
        })
        return true
      }

      if (pathname === '/internal/runtime/session/page' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const cursor = url.searchParams.get('cursor') ?? undefined
        const directionParam = url.searchParams.get('direction')
        const direction = directionParam === null ? undefined : directionParam
        if (direction !== undefined && direction !== 'older' && direction !== 'newer') {
          throw new ConversationReadError('protocol', 'invalid conversation page direction')
        }
        const parseOptional = (name: string): number | undefined => {
          const raw = url.searchParams.get(name)
          if (raw === null) return undefined
          const value = Number(raw)
          if (!safeInteger(value)) throw new ConversationReadError('protocol', `invalid conversation page ${name}`)
          return value
        }
        const pageRequest: ConversationPageRequest = {
          ...(cursor === undefined ? {} : { cursor }),
          ...(direction === undefined ? {} : { direction }),
          ...(url.searchParams.has('beforeSeq') ? { beforeSeq: parseOptional('beforeSeq') } : {}),
          ...(url.searchParams.has('fromSeq') ? { fromSeq: parseOptional('fromSeq') } : {}),
          ...(url.searchParams.has('maxBytes') ? { maxBytes: parseOptional('maxBytes') } : {}),
          ...(url.searchParams.has('maxEvents') ? { maxEvents: parseOptional('maxEvents') } : {}),
          ...(url.searchParams.has('maxGroups') ? { maxGroups: parseOptional('maxGroups') } : {}),
        }
        const signal = requestSignal(req, res)
        // Authorize from the indexed header before asking a repository for
        // event rows; the post-read check below covers a concurrent ownership
        // change without exposing a foreign page in the response.
        const header = await storedHeader(sessionId, subject, signal)
        if (header === undefined) throw new CollaborationDeniedError('conversation-not-found')
        const page = deps.conversations.readPage !== undefined
          ? await deps.conversations.readPage(sessionId, pageRequest, signal)
          : await fallbackPage(sessionId, subject, pageRequest, signal)
        if (page === undefined || !belongsToRuntime(page.header, subject) || page.header.id !== header.id) {
          throw new CollaborationDeniedError('conversation-not-found')
        }
        validateConversationRange(page.events, page.startSeq ?? (pageRequest.fromSeq ?? 0))
        send(res, 200, {
          header: runtimeHeader(page.header),
          events: page.events,
          revision: revisionFor(subject, page.revision),
          startSeq: page.startSeq,
          endSeq: page.endSeq,
          hasMore: page.hasMore,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          uncompressedBytes: page.uncompressedBytes,
        })
        return true
      }

      if (pathname === '/internal/runtime/session/revision' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const signal = requestSignal(req, res)
        const value = await storedHeader(sessionId, subject, signal)
        const revision = value === undefined
          ? undefined
          : deps.conversations.revision !== undefined
            ? await deps.conversations.revision(sessionId, signal)
            : (await stored(sessionId, subject))?.revision
        send(res, 200, {
          revision: revision === undefined ? null : revisionFor(subject, revision),
        })
        return true
      }

      if (pathname === '/internal/runtime/session/remove' && req.method === 'POST') {
        const payload = record(JSON.parse(body))
        const sessionId = payload?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') throw new Error('invalid session id')
        if (subject.target.kind !== 'project') {
          send(res, 409, { error: 'personal-session-removal-is-runtime-local' })
          return true
        }
        if (await storedHeader(sessionId, subject, requestSignal(req, res)) === undefined) {
          throw new CollaborationDeniedError('conversation-not-found')
        }
        await deps.conversations.removeTree(subject.organizationId, sessionId)
        send(res, 200, { removed: true })
        return true
      }

      if (pathname === '/internal/runtime/session/list' && req.method === 'GET') {
        const items = await deps.conversations.listScoped({
          organizationId: subject.organizationId,
          ...(subject.projectInternalId === undefined ? {} : { projectId: subject.projectInternalId }),
          ...(subject.userInternalId === undefined ? {} : { creatorUserId: subject.userInternalId }),
        })
        send(res, 200, { items: items.map(item => ({
          header: runtimeHeader(item.header),
          revision: revisionFor(subject, item.revision),
          content: item.content,
        })) })
        return true
      }

      if (pathname === '/internal/runtime/session/repair' && req.method === 'POST') {
        const payload = record(JSON.parse(body))
        if (typeof payload?.sessionId !== 'string' || typeof payload.batchId !== 'string') {
          throw new Error('invalid repair request')
        }
        if (await storedHeader(payload.sessionId, subject, requestSignal(req, res)) === undefined) {
          throw new CollaborationDeniedError('conversation-not-found')
        }
        const closers = conversationEvents(payload.closers)
        if (closers.length > 0) {
          const result = await deps.conversations.append(payload.sessionId, payload.batchId, closers)
          if (result === 'inserted' && deps.push !== undefined) {
            for (const eventSeq of completedTurnEndSeqs(closers)) {
              void deps.push.notifyCompleted(payload.sessionId, eventSeq).catch((error: unknown) => {
                console.error(`[gateway] repaired-turn push failed for ${payload.sessionId}:`, error)
              })
            }
          }
        }
        send(res, 200, { repaired: true })
        return true
      }

      if (pathname === '/internal/runtime/collaboration/authorize' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        const payload = record(JSON.parse(body))
        if (typeof payload?.sessionId !== 'string'
          || (payload.action !== 'read' && payload.action !== 'write'
            && payload.action !== 'manage' && payload.action !== 'approve')) {
          throw new Error('invalid authorization request')
        }
        const creationAuthorization = payload.creationAuthorization
        if (creationAuthorization !== undefined
          && (typeof creationAuthorization !== 'string' || creationAuthorization === '')) {
          throw new Error('invalid authorization request')
        }
        if (subject.target.kind === 'user') {
          const value = await storedHeader(payload.sessionId, subject, requestSignal(req, res))
          if (value === undefined) throw new CollaborationDeniedError('conversation-not-found')
          send(res, 200, {
            access: {
              sessionId: value.id,
              rootSessionId: value.rootSessionId ?? value.id,
              mode: 'rw',
              canRead: true,
              canWrite: true,
              canManage: true,
            },
          })
          return true
        }
        try {
          send(res, 200, { access: await deps.collaboration.access(claims.user.id, payload.sessionId, payload.action) })
        } catch (error: unknown) {
          if (!(error instanceof CollaborationDeniedError && error.code === 'conversation-not-found')
            || creationAuthorization === undefined) throw error
          send(res, 200, {
            access: await creationAccess(
              creationAuthorization,
              subject,
              claims,
              payload.sessionId,
              payload.action,
            ),
          })
        }
        return true
      }

      if (pathname === '/internal/runtime/collaboration/claim-interaction' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        const payload = record(JSON.parse(body))
        if (subject.target.kind !== 'project' || typeof payload?.sessionId !== 'string'
          || (payload.kind !== 'approval' && payload.kind !== 'question')
          || typeof payload.interactionId !== 'string' || payload.interactionId === '') {
          throw new Error('invalid interaction claim')
        }
        send(res, 200, {
          claimed: await deps.collaboration.claimInteraction(
            claims.user.id,
            payload.sessionId,
            payload.kind,
            payload.interactionId,
            payload.outcome,
          ),
        })
        return true
      }

      if (pathname === '/internal/runtime/collaboration/readable' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        const payload = record(JSON.parse(body))
        if (subject.target.kind !== 'project' || !Array.isArray(payload?.sessionIds)
          || payload.sessionIds.length > MAX_READABLE_SESSION_IDS
          || !payload.sessionIds.every(id => typeof id === 'string' && id !== '' && id.length <= 512)) {
          throw new Error('invalid readable session request')
        }
        const requested = new Set(payload.sessionIds)
        const authorizations = payload.creationAuthorizations === undefined
          ? []
          : payload.creationAuthorizations
        if (!Array.isArray(authorizations) || authorizations.length > payload.sessionIds.length
          || !authorizations.every((candidate) => {
            const entry = record(candidate)
            return typeof entry?.sessionId === 'string' && requested.has(entry.sessionId)
              && typeof entry.authorization === 'string' && entry.authorization !== ''
          })) {
          throw new Error('invalid readable session request')
        }
        // PostgreSQL's array parameter and query planner stay bounded even
        // when a client has a large local session index. Preserve request
        // order in the response while querying fixed-size chunks.
        const readable = new Set<string>()
        for (let offset = 0; offset < payload.sessionIds.length; offset += READABLE_SESSION_BATCH_SIZE) {
          const batch = payload.sessionIds.slice(offset, offset + READABLE_SESSION_BATCH_SIZE)
          for (const id of await deps.collaboration.readableSessionIds(claims.user.id, subject.target.id, batch)) {
            readable.add(id)
          }
        }
        for (const candidate of authorizations) {
          const entry = record(candidate)!
          const sessionId = entry.sessionId as string
          if (await storedHeader(sessionId, subject, requestSignal(req, res)) !== undefined) continue
          try {
            await creationAccess(
              entry.authorization as string,
              subject,
              claims,
              sessionId,
              'read',
            )
            readable.add(sessionId)
          } catch (error: unknown) {
            if (!(error instanceof CollaborationDeniedError
              && (error.code === 'forbidden' || error.code === 'not-member'))) throw error
          }
        }
        send(res, 200, {
          sessionIds: payload.sessionIds.filter(sessionId => readable.has(sessionId)),
        })
        return true
      }

      return false
    } catch (error) {
      if (error instanceof DocumentCatalogError) {
        send(res, error.status, { error: error.code, message: error.message })
        return true
      }
      if (error instanceof DocumentTransferError) {
        send(res, error.status, { error: error.code, message: error.message })
        return true
      }
      if (error instanceof ConversationReadError) {
        const status = error.code === 'too-large' ? 413 : error.code === 'protocol' ? 400
          : error.code === 'aborted' ? 499 : error.code === 'timeout' ? 504 : 503
        send(res, status, { error: `conversation-${error.code}`, code: error.code, message: error.message })
        return true
      }
      if (error instanceof CollaborationDeniedError) {
        const status = error.code === 'conversation-not-found' ? 404
          : error.code === 'visibility-locked' ? 409 : 403
        send(res, status, { error: error.code })
        return true
      }
      if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith('invalid '))) {
        send(res, 400, { error: error instanceof Error ? error.message : 'invalid request' })
        return true
      }
      throw error
    } finally {
      // A route may create more than one request signal while checking
      // metadata and ACLs. Dispose all listeners once the route has returned,
      // including error and cancellation paths.
      disposeRequestSignals(res)
    }
  }
}
