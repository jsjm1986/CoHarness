import { createHash } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { transaction, type Queryable } from './database.ts'
import { assertSafeAssistantEvent } from '../conversation-safety.ts'

export type ConversationVisibility = 'personal' | 'project' | 'private'

export interface ConversationHeader {
  id: string
  organizationId: string
  creatorUserId?: string
  projectId?: string
  parentSessionId?: string
  rootSessionId?: string
  visibility?: ConversationVisibility
  sessionFormatVersion: number
  createdAt: number
  cwd?: string
  seedLength?: number
  origin?: string
  delegationDepth?: number
  agentPreset?: string
  draft?: boolean
  title?: string
}

export interface StoredConversation {
  header: ConversationHeader
  events: ConversationEvent[]
  revision: string
}

/** Direction for a bounded conversation event page. */
export type ConversationPageDirection = 'older' | 'newer'

/** Request for one bounded, revision-aware conversation page. */
export interface ConversationPageRequest {
  cursor?: string
  beforeSeq?: number
  fromSeq?: number
  direction?: ConversationPageDirection
  maxBytes?: number
  maxEvents?: number
  maxGroups?: number
}

/** One bounded page returned without materializing the complete conversation. */
export interface ConversationPage {
  header: ConversationHeader
  events: ConversationEvent[]
  revision: string
  startSeq: number | null
  endSeq: number | null
  hasMore: boolean
  nextCursor?: string
  uncompressedBytes: number
}

/** One bounded turn marker returned by the history navigation index. */
export interface ConversationHistoryIndexItem {
  turn: number
  startSeq: number
  endSeq: number
  prompt?: string
  response?: string
}

/** Revision-bound, payload-light index for navigating a conversation. */
export interface ConversationHistoryIndex {
  revision: string
  asOfSeq: number
  totalTurns: number
  items: ConversationHistoryIndexItem[]
  truncated: boolean
}

/** Stable failure category for a bounded conversation observation. */
export type ConversationReadErrorCode = 'too-large' | 'aborted' | 'timeout' | 'dependency' | 'protocol'

/** Error raised by bounded conversation reads. */
export class ConversationReadError extends Error {
  constructor(readonly code: ConversationReadErrorCode, message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'ConversationReadError'
  }
}

/** Raised when one indivisible event exceeds a page's byte budget. */
export class ConversationPageTooLargeError extends ConversationReadError {
  constructor(readonly bytes: number, readonly limit: number) {
    super('too-large', `conversation page event is ${String(bytes)} bytes, exceeding the ${String(limit)}-byte limit`)
    this.name = 'ConversationPageTooLargeError'
  }
}

/** Durable content facts used by cold session-list projections. */
export interface ConversationContentMetadata {
  blank: boolean
  visibleContentSeq: number | null
  lastPromptAt: number | null
}

/** One lightweight scoped session row with its authoritative content facts. */
export interface ConversationListSnapshot {
  header: ConversationHeader
  revision: string
  content: ConversationContentMetadata
}

/** Scope-qualified browser draft reservation request. No prompt data is stored. */
export interface ConversationDraftReservationInput {
  organizationId: string
  scopeKey: string
  draftId: string
  sessionId: string
  userId?: string
  projectId?: string
  cwd: string
  visibility: ConversationVisibility
  agentPreset?: string
}

/** Canonical session identity returned by a draft reservation. */
export interface ConversationDraftReservation {
  draftId: string
  sessionId: string
  leaseExpiresAt: number
  created: boolean
}

export interface ConversationEvent {
  type: string
  seq: number
  time: number
  data: unknown
  sourceEventSeqs?: number[]
  surfaceOp?: unknown
  ignorable?: true
}

function contentBlocks(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function eventHasVisibleContent(event: ConversationEvent): boolean {
  if (event.type === 'user/message') {
    return contentBlocks((event.data as { content?: unknown }).content).length > 0
  }
  if (event.type === 'assistant/message' || event.type === 'tool/result') {
    return contentBlocks((event.data as { message?: { content?: unknown } }).message?.content).length > 0
  }
  return false
}

function eventPromptTime(event: ConversationEvent): number | undefined {
  if (event.type !== 'user/message') return undefined
  const source = (event.data as { source?: { kind?: unknown } }).source
  return source?.kind === 'user' ? event.time : undefined
}

function serialized(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('conversation value is not JSON serializable')
  return encoded
}

function eventText(event: ConversationEvent): { role: 'user' | 'assistant' | 'tool'; content: string } | undefined {
  if (event.type === 'user/message') {
    const data = event.data as { content?: unknown }
    return { role: 'user', content: messageText(data) }
  }
  if (event.type === 'assistant/message') {
    const data = event.data as { message?: { content?: unknown } }
    return { role: 'assistant', content: messageText(data.message) }
  }
  if (event.type === 'tool/result') {
    const data = event.data as { message?: { content?: unknown } }
    return { role: 'tool', content: messageText(data.message) }
  }
  return undefined
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const value = block as { type?: unknown; text?: unknown; content?: unknown }
    if (value.type === 'text' && typeof value.text === 'string') return [value.text]
    if (value.type === 'tool-result') {
      const nested = contentText(value.content)
      return nested === '' ? [] : [nested]
    }
    return []
  }).join('\n')
}

function messageText(message: { content?: unknown } | undefined): string {
  return contentText(message?.content)
}

function historyIndexPreview(value: string): string | undefined {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized === '') return undefined
  return Array.from(normalized).slice(0, MAX_HISTORY_INDEX_PREVIEW_CODE_POINTS).join('')
}

function eventTurn(event: ConversationEvent): number | undefined {
  if (typeof event.data !== 'object' || event.data === null) return undefined
  const value = (event.data as { turn?: unknown }).turn
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function sampledIndexes(total: number, maximum: number): number[] {
  if (total <= maximum) return Array.from({ length: total }, (_, index) => index)
  if (maximum === 1) return [0]
  const indexes = new Set<number>([0, total - 1])
  for (let index = 0; index < maximum; index++) {
    indexes.add(Math.round(index * (total - 1) / (maximum - 1)))
  }
  return [...indexes].sort((left, right) => left - right)
}

function turnOrdinalAtSeq(starts: readonly { startSeq: number }[], seq: number): number {
  let low = 0
  let high = starts.length - 1
  let found = -1
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    const candidate = starts[middle]
    if (candidate === undefined || candidate.startSeq > seq) high = middle - 1
    else {
      found = middle
      low = middle + 1
    }
  }
  return found
}

/**
 * Fold an already available event range into bounded turn markers. This is
 * used for attached sessions and keeps the same output rules as the indexed
 * PostgreSQL reader without copying raw chunk payloads into the result.
 * @param events - ordered session events.
 * @param revision - source revision represented by the events.
 * @param maxItems - maximum markers to return.
 * @returns a bounded navigation index.
 */
export function conversationHistoryIndexFromEvents(
  events: readonly ConversationEvent[],
  revision: string,
  maxItems = DEFAULT_HISTORY_INDEX_MAX_ITEMS,
): ConversationHistoryIndex {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > DEFAULT_HISTORY_INDEX_MAX_ITEMS) {
    throw new ConversationReadError('protocol', 'conversation history index maxItems is invalid')
  }
  const starts = events
    .filter(event => event.type === 'turn/start' && eventTurn(event) !== undefined)
    .map(event => ({ turn: eventTurn(event) as number, startSeq: event.seq }))
  const selected = sampledIndexes(starts.length, maxItems)
  const selectedByOrdinal = new Map(selected.map((ordinal, index) => [ordinal, index]))
  const ordinalByTurn = new Map(starts.map((start, index) => [start.turn, index]))
  const items: ConversationHistoryIndexItem[] = selected.map((ordinal) => {
    const start = starts[ordinal]!
    const next = starts[ordinal + 1]
    return {
      turn: start.turn,
      startSeq: start.startSeq,
      endSeq: (next?.startSeq ?? (events.at(-1)?.seq ?? start.startSeq)) - 1,
    }
  })
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const turn = eventTurn(event)
    if (turn === undefined) continue
    const ordinal = ordinalByTurn.get(turn) ?? turnOrdinalAtSeq(starts, event.seq)
    const itemIndex = selectedByOrdinal.get(ordinal)
    if (itemIndex === undefined) continue
    const item = items[itemIndex]!
    const content = eventText(event)?.content ?? ''
    const preview = historyIndexPreview(content)
    if (preview === undefined) continue
    if (event.type === 'user/message' && item.prompt === undefined) item.prompt = preview
    if (event.type === 'assistant/message') item.response = preview
  }
  return {
    revision,
    asOfSeq: events.at(-1)?.seq ?? -1,
    totalTurns: starts.length,
    items,
    truncated: selected.length < starts.length,
  }
}

function participantUserId(event: ConversationEvent): number | undefined {
  if (event.type !== 'user/message' || typeof event.data !== 'object' || event.data === null) return undefined
  const source = (event.data as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const participant = (source as { participant?: unknown }).participant
  if (typeof participant !== 'object' || participant === null) return undefined
  const userId = (participant as { userId?: unknown }).userId
  return typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0 ? userId : undefined
}

interface StoredHeaderRow {
  id: string
  organization_id: string
  creator_user_id: string
  project_id: string | null
  parent_session_id: string | null
  root_session_id: string
  visibility: ConversationVisibility
  session_format_version: number
  created_at_ms: string
  cwd: string | null
  seed_length: string | null
  origin: string | null
  delegation_depth: number | null
  agent_preset: string | null
  draft: boolean
  title: string | null
  version: string
  next_seq: string
  has_visible_content: boolean
  visible_content_seq: string | null
  last_prompt_at_ms: string | null
}

interface ResolvedConversationHeader {
  id: string
  organizationId: string
  creatorUserId: string
  projectId: string | null
  parentSessionId: string | null
  rootSessionId: string
  visibility: ConversationVisibility
  sessionFormatVersion: number
  createdAt: number
  cwd: string | null
  seedLength: number | null
  origin: string | null
  delegationDepth: number | null
  agentPreset: string | null
  draft: boolean
  title: string | null
}

function headerFromRow(row: StoredHeaderRow): ConversationHeader {
  return {
    id: row.id,
    organizationId: row.organization_id,
    creatorUserId: row.creator_user_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    rootSessionId: row.root_session_id,
    visibility: row.visibility,
    sessionFormatVersion: row.session_format_version,
    createdAt: Number(row.created_at_ms),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(row.seed_length === null ? {} : { seedLength: Number(row.seed_length) }),
    ...(row.origin === null ? {} : { origin: row.origin }),
    ...(row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth }),
    ...(row.agent_preset === null ? {} : { agentPreset: row.agent_preset }),
    ...(row.draft ? { draft: true } : {}),
    ...(row.title === null ? {} : { title: row.title }),
  }
}

const HEADER_COLUMNS = `id,organization_id,creator_user_id,project_id,parent_session_id,root_session_id,visibility,
  session_format_version,(extract(epoch FROM created_at)*1000)::bigint::text created_at_ms,cwd,
  seed_length::text,origin,delegation_depth,agent_preset,draft,title,version::text,next_seq::text,
  has_visible_content,visible_content_seq::text,(extract(epoch FROM last_prompt_at)*1000)::bigint::text last_prompt_at_ms`

const DEFAULT_PAGE_MAX_BYTES = 512 * 1024
const DEFAULT_PAGE_MAX_EVENTS = 2_000
const DEFAULT_PAGE_MAX_GROUPS = 50
const MAX_PAGE_QUERY_EVENTS = 10_000
const MAX_PAGE_CURSOR_LENGTH = 16 * 1024
const DEFAULT_HISTORY_INDEX_MAX_ITEMS = 2_000
const MAX_HISTORY_INDEX_PREVIEW_CODE_POINTS = 160
const MAX_HISTORY_INDEX_SEARCH_ROWS = 20_000
/** Keep one multi-row INSERT comfortably below PostgreSQL's parameter limit. */
const APPEND_INSERT_BATCH_SIZE = 500
/** Keep SQL text and parameter buffers bounded when one event is unusually large. */
const APPEND_INSERT_BATCH_BYTES = 4 * 1024 * 1024

interface ConversationEventRow {
  event: ConversationEvent
  seq: string
  payload_bytes: number
}

interface HistoryIndexStartRow {
  start_seq: string
  end_seq: string
  turn: string
  ordinal: string
  total: string
}

interface HistoryIndexSearchRow {
  event_seq: string
  role: 'user' | 'assistant'
  content: string
}

interface ConversationSearchInsertRow {
  role: 'user' | 'assistant' | 'tool'
  content: string
  seq: number
  time: number
}

async function insertConversationEvents(
  client: PoolClient,
  sessionId: string,
  events: readonly { event: ConversationEvent; json: string; payloadBytes: number }[],
): Promise<void> {
  let offset = 0
  while (offset < events.length) {
    const batch: typeof events[number][] = []
    let batchBytes = 0
    while (offset + batch.length < events.length && batch.length < APPEND_INSERT_BATCH_SIZE) {
      const candidate = events[offset + batch.length]!
      const candidateBytes = Buffer.byteLength(candidate.json, 'utf8')
      if (batch.length > 0 && batchBytes + candidateBytes > APPEND_INSERT_BATCH_BYTES) break
      batch.push(candidate)
      batchBytes += candidateBytes
    }
    const values: unknown[] = []
    const rows = batch.map(({ event, json, payloadBytes }, index) => {
      const base = index * 6
      values.push(sessionId, event.seq, event.type, event.time, json, payloadBytes)
      return `($${String(base + 1)},$${String(base + 2)},$${String(base + 3)},to_timestamp($${String(base + 4)}/1000.0),$${String(base + 5)}::json,$${String(base + 6)})`
    }).join(',')
    await client.query(`INSERT INTO harness.conversation_events(
      session_id,seq,event_type,occurred_at,event,payload_bytes
    ) VALUES${rows}`, values)
    offset += batch.length
  }
}

async function insertConversationSearch(
  client: PoolClient,
  sessionId: string,
  rows: readonly ConversationSearchInsertRow[],
): Promise<void> {
  let offset = 0
  while (offset < rows.length) {
    const batch: ConversationSearchInsertRow[] = []
    let batchBytes = 0
    while (offset + batch.length < rows.length && batch.length < APPEND_INSERT_BATCH_SIZE) {
      const candidate = rows[offset + batch.length]!
      const candidateBytes = Buffer.byteLength(candidate.content, 'utf8')
      if (batch.length > 0 && batchBytes + candidateBytes > APPEND_INSERT_BATCH_BYTES) break
      batch.push(candidate)
      batchBytes += candidateBytes
    }
    const values: unknown[] = []
    const placeholders = batch.map(({ role, content, seq, time }, index) => {
      const base = index * 5
      values.push(sessionId, seq, role, content, time)
      return `($${String(base + 1)},$${String(base + 2)},$${String(base + 3)},$${String(base + 4)},to_timestamp($${String(base + 5)}/1000.0))`
    }).join(',')
    await client.query(`INSERT INTO harness.conversation_search(session_id,event_seq,role,content,occurred_at)
      VALUES${placeholders}`, values)
    offset += batch.length
  }
}

function validateReadRows(
  rows: readonly { event: ConversationEvent; seq: string }[],
  fromSeq: number,
): void {
  let previous = fromSeq - 1
  let first = true
  for (const row of rows) {
    const seq = Number(row.seq)
    if (!Number.isSafeInteger(seq) || seq < fromSeq || row.event.seq !== seq
      || (first && seq !== fromSeq)
      || (!first && seq !== previous + 1)) {
      throw new ConversationReadError('protocol', 'conversation read returned an invalid sequence range')
    }
    previous = seq
    first = false
  }
}

/** Revision-bound payload encoded in a conversation page continuation cursor. */
export interface ConversationCursorPayload {
  version: 1
  sessionId: string
  revision: string
  direction: ConversationPageDirection
  anchor: number
}

function assertSignal(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

/** Normalize database cancellation and connectivity failures for read callers. */
function normalizeReadError(error: unknown, signal?: AbortSignal): ConversationReadError | undefined {
  if (error instanceof ConversationReadError) return error
  if (signal?.aborted) return new ConversationReadError('aborted', 'conversation read was cancelled', { cause: error })
  const code = errorCode(error)
  if (code === '57014' || code === '55P03' || code === 'ETIMEDOUT') {
    return new ConversationReadError('timeout', 'conversation read timed out', { cause: error })
  }
  if (code?.startsWith('08') === true || code === 'ECONNRESET' || code === 'ECONNREFUSED'
    || code === 'EPIPE' || code === '53300' || code === 'DB_CHECKOUT_QUEUE_FULL'
    || code === '57P01' || code === '57P02' || code === '57P03') {
    return new ConversationReadError('dependency', 'conversation storage is temporarily unavailable', { cause: error })
  }
  return undefined
}

async function checkedQuery<R extends QueryResultRow>(
  source: Queryable,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<{ rows: R[]; rowCount: number | null }> {
  assertSignal(signal)
  const result = await source.query<R>(text, values)
  assertSignal(signal)
  return result
}

function pageDirection(request: ConversationPageRequest): ConversationPageDirection {
  const cursorDirection = request.cursor === undefined
    ? undefined
    : decodePageCursor(request.cursor).direction
  const direction = request.direction
    ?? cursorDirection
    ?? (request.beforeSeq !== undefined ? 'older' : request.fromSeq !== undefined ? 'newer' : 'older')
  if (direction !== 'older' && direction !== 'newer') {
    throw new ConversationReadError('protocol', 'conversation page direction is invalid')
  }
  if (cursorDirection !== undefined && cursorDirection !== direction) {
    throw new ConversationReadError('protocol', 'conversation page direction does not match its cursor')
  }
  return direction
}

function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > fallback) {
    throw new ConversationReadError(
      'protocol',
      `conversation page ${name} must be a positive safe integer no greater than ${String(fallback)}`,
    )
  }
  return resolved
}

function optionalSeq(name: string, value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ConversationReadError('protocol', `conversation page ${name} must be a non-negative safe integer`)
  }
  return value
}

/** Encode one canonical revision-bound conversation page cursor. */
export function encodePageCursor(payload: ConversationCursorPayload): string {
  if (payload.version !== 1 || payload.sessionId === '' || payload.revision === ''
    || (payload.direction !== 'older' && payload.direction !== 'newer')
    || !Number.isSafeInteger(payload.anchor) || payload.anchor < 0) {
    throw new ConversationReadError('protocol', 'conversation page cursor fields are invalid')
  }
  return Buffer.from(JSON.stringify([
    payload.version,
    payload.sessionId,
    payload.revision,
    payload.direction,
    payload.anchor,
  ]), 'utf8').toString('base64url')
}

/** Decode and validate one canonical revision-bound conversation page cursor. */
export function decodePageCursor(value: string): ConversationCursorPayload {
  if (value === '' || value.length > MAX_PAGE_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ConversationReadError('protocol', 'conversation page cursor is invalid')
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(decoded) || decoded.length !== 5 || decoded[0] !== 1
      || typeof decoded[1] !== 'string' || decoded[1] === ''
      || typeof decoded[2] !== 'string' || decoded[2] === ''
      || (decoded[3] !== 'older' && decoded[3] !== 'newer')
      || typeof decoded[4] !== 'number' || !Number.isSafeInteger(decoded[4]) || decoded[4] < 0) {
      throw new Error('invalid fields')
    }
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== value) throw new Error('non-canonical')
    return {
      version: 1,
      sessionId: decoded[1],
      revision: decoded[2],
      direction: decoded[3],
      anchor: decoded[4],
    }
  } catch (error: unknown) {
    if (error instanceof ConversationReadError) throw error
    throw new ConversationReadError('protocol', 'conversation page cursor is invalid', { cause: error })
  }
}

function eventBytes(row: ConversationEventRow): number {
  const encoded = JSON.stringify(row.event)
  if (encoded === undefined) throw new ConversationReadError('protocol', 'conversation event is not JSON serializable')
  const actual = Buffer.byteLength(encoded, 'utf8')
  // `payload_bytes` is an acceleration hint maintained by the append path;
  // never let a stale or under-reported column bypass the page budget.
  return Number.isSafeInteger(row.payload_bytes) && row.payload_bytes >= 0
    ? Math.max(row.payload_bytes, actual)
    : actual
}

function eventNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Return the logical page group for one event. Stream chunks do not carry
 * `sourceEventSeqs`, so grouping every chunk by its own sequence silently
 * reduced a page to a few dozen tokens. Turn/step coordinates keep all
 * chunks from one model step in one group while call ids keep tool lifecycles
 * independent.
 */
export function conversationEventGroupKey(event: ConversationEvent): string {
  const sources = event.sourceEventSeqs
  if (sources !== undefined && sources.length > 0) {
    let start = event.seq
    for (const seq of sources) if (seq < start) start = seq
    return `source:${String(start)}`
  }
  const data = typeof event.data === 'object' && event.data !== null
    ? event.data as { turn?: unknown; step?: unknown; callId?: unknown }
    : {}
  const turn = eventNumber(data.turn)
  const step = eventNumber(data.step)
  if (event.type === 'user/message') return `message:${String(event.seq)}`
  if ((event.type === 'tool/call' || event.type === 'tool/result')
    && turn !== undefined && step !== undefined && typeof data.callId === 'string' && data.callId !== '') {
    return `call:${String(turn)}:${String(step)}:${data.callId}`
  }
  if (turn !== undefined && step !== undefined) return `step:${String(turn)}:${String(step)}`
  if (turn !== undefined) return `turn:${String(turn)}`
  if (event.type === 'assistant/message' || event.type === 'tool/result') return `message:${String(event.seq)}`
  return `event:${String(event.seq)}`
}

function selectPageRows(
  rows: readonly ConversationEventRow[],
  direction: ConversationPageDirection,
  maxBytes: number,
  maxEvents: number,
  maxGroups: number,
): { rows: ConversationEventRow[]; bytes: number; hasMore: boolean } {
  const selected: ConversationEventRow[] = []
  const groups = new Set<string>()
  let bytes = 0
  let index = direction === 'older' ? rows.length - 1 : 0
  const step = direction === 'older' ? -1 : 1
  while (index >= 0 && index < rows.length) {
    const row = rows[index]!
    const size = eventBytes(row)
    if (selected.length === 0 && size > maxBytes) throw new ConversationPageTooLargeError(size, maxBytes)
    const group = conversationEventGroupKey(row.event)
    if (selected.length >= maxEvents || bytes + size > maxBytes
      || (!groups.has(group) && groups.size >= maxGroups)) break
    selected.push(row)
    groups.add(group)
    bytes += size
    index += step
  }
  selected.sort((left, right) => Number(left.seq) - Number(right.seq))
  return { rows: selected, bytes, hasMore: selected.length < rows.length }
}

/** Validate the logical sequence carried by one bounded database result. */
function validatePageRows(rows: readonly ConversationEventRow[]): void {
  let previous = -1
  for (const row of rows) {
    const seq = Number(row.seq)
    if (!Number.isSafeInteger(seq) || seq < 0 || row.event.seq !== seq
      || (previous >= 0 && seq !== previous + 1)) {
      throw new ConversationReadError('protocol', 'conversation page contains an invalid sequence range')
    }
    previous = seq
  }
}

/** Reject a bounded query that starts after a missing logical sequence. */
function validatePageAnchor(
  rows: readonly ConversationEventRow[],
  direction: ConversationPageDirection,
  anchor: number,
  nextSeq: number,
): void {
  if (rows.length === 0) {
    if ((direction === 'newer' && anchor < nextSeq)
      || (direction === 'older' && Math.min(anchor, nextSeq) > 0)) {
      throw new ConversationReadError('protocol', 'conversation page query returned an unexpected sequence gap')
    }
    return
  }
  const first = Number(rows[0]!.seq)
  const last = Number(rows.at(-1)!.seq)
  const expected = direction === 'newer'
    ? anchor
    : Math.min(anchor, nextSeq) - 1
  if ((direction === 'newer' && first !== expected)
    || (direction === 'older' && last !== expected)) {
    throw new ConversationReadError('protocol', 'conversation page query returned an unexpected sequence gap')
  }
}

export class ConversationRepository {
  constructor(private readonly pool: Pool) {}

  /** Resolve an active project writer, including organization administrators. */
  private async projectWriter(
    client: PoolClient,
    organizationId: string,
    projectId: string,
    selector: { readonly internalId: string } | { readonly publicId: number },
  ): Promise<{ id: string; administrator: boolean } | undefined> {
    const predicate = 'internalId' in selector ? 'u.id=$2' : 'u.public_id=$2'
    const result = await client.query<{ id: string; administrator: boolean }>(`SELECT u.id,
      EXISTS (SELECT 1 FROM harness.memberships om
        WHERE om.organization_id=u.organization_id AND om.user_id=u.id
          AND om.status='active' AND om.role='admin') administrator
      FROM harness.users u
      JOIN harness.projects p ON p.organization_id=u.organization_id
        AND p.id=$3 AND p.status='active'
      WHERE u.organization_id=$1 AND ${predicate} AND u.status='active'
        AND (EXISTS (SELECT 1 FROM harness.project_members pm
          WHERE pm.organization_id=u.organization_id AND pm.project_id=p.id
            AND pm.user_id=u.id AND pm.access_mode='rw')
          OR EXISTS (SELECT 1 FROM harness.memberships om
            WHERE om.organization_id=u.organization_id AND om.user_id=u.id
              AND om.status='active' AND om.role='admin'))
      FOR SHARE OF u,p`, [organizationId,
      'internalId' in selector ? selector.internalId : selector.publicId, projectId])
    const row = result.rows[0]
    return row === undefined ? undefined : { id: row.id, administrator: row.administrator }
  }

  private async assertProjectCreatorMembership(
    client: PoolClient,
    organizationId: string,
    projectId: string,
    creatorUserId: string,
  ): Promise<void> {
    if (await this.projectWriter(client, organizationId, projectId, { internalId: creatorUserId }) === undefined) {
      throw new Error(`conversation creator ${creatorUserId} is not an active rw project member`)
    }
  }

  private async resolveHeader(client: PoolClient, header: ConversationHeader): Promise<ResolvedConversationHeader> {
    let projectId = header.projectId ?? null
    let rootSessionId = header.rootSessionId ?? header.id
    let visibility = header.visibility ?? (projectId === null ? 'personal' : 'project')
    let creatorUserId = header.creatorUserId
    if (header.parentSessionId !== undefined) {
      const parent = await client.query<{
        organization_id: string
        project_id: string | null
        root_session_id: string
        visibility: ConversationVisibility
        creator_user_id: string
      }>(`SELECT p.organization_id,p.project_id,p.root_session_id,r.visibility,r.creator_user_id
        FROM harness.conversation_sessions p
        JOIN harness.conversation_sessions r ON r.id=p.root_session_id AND r.organization_id=p.organization_id
        WHERE p.id=$1 AND p.status<>'deleted' AND r.status<>'deleted'`, [header.parentSessionId])
      const row = parent.rows[0]
      if (row === undefined) throw new Error(`unknown parent conversation session ${header.parentSessionId}`)
      if (row.organization_id !== header.organizationId) {
        throw new Error(`parent conversation session ${header.parentSessionId} belongs to another organization`)
      }
      if (projectId !== null && projectId !== row.project_id) {
        throw new Error(`parent conversation session ${header.parentSessionId} belongs to another project`)
      }
      const root = await client.query<{
        project_id: string | null
        visibility: ConversationVisibility
        creator_user_id: string
      }>(`SELECT project_id,visibility,creator_user_id FROM harness.conversation_sessions
        WHERE id=$1 AND organization_id=$2 AND status<>'deleted' FOR UPDATE`,
      [row.root_session_id, header.organizationId])
      const lockedRoot = root.rows[0]
      if (lockedRoot === undefined) throw new Error(`unknown root conversation session ${row.root_session_id}`)
      const lockedParent = await client.query(`SELECT id FROM harness.conversation_sessions
        WHERE id=$1 AND organization_id=$2 AND status<>'deleted' FOR SHARE`,
      [header.parentSessionId, header.organizationId])
      if (lockedParent.rows[0] === undefined) {
        throw new Error(`unknown parent conversation session ${header.parentSessionId}`)
      }
      projectId = lockedRoot.project_id
      rootSessionId = row.root_session_id
      visibility = lockedRoot.visibility
      creatorUserId = lockedRoot.creator_user_id
    } else if (rootSessionId !== header.id) {
      throw new Error(`root conversation session ${header.id} cannot name another root`)
    }
    if (creatorUserId === undefined) throw new Error(`conversation session ${header.id} has no creator`)
    if ((projectId === null && visibility !== 'personal')
      || (projectId !== null && visibility !== 'project' && visibility !== 'private')) {
      throw new Error(`conversation session ${header.id} has invalid scope visibility`)
    }
    if (header.parentSessionId === undefined && projectId !== null) {
      await this.assertProjectCreatorMembership(client, header.organizationId, projectId, creatorUserId)
    }
    return {
      id: header.id,
      organizationId: header.organizationId,
      creatorUserId,
      projectId,
      parentSessionId: header.parentSessionId ?? null,
      rootSessionId,
      visibility,
      sessionFormatVersion: header.sessionFormatVersion,
      createdAt: header.createdAt,
      cwd: header.cwd ?? null,
      seedLength: header.seedLength ?? null,
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? null,
      agentPreset: header.agentPreset ?? null,
      draft: header.draft ?? false,
      title: header.title ?? null,
    }
  }

  private assertSameHeader(row: StoredHeaderRow, header: ResolvedConversationHeader): void {
    const same = row.id === header.id
      && row.organization_id === header.organizationId
      && row.creator_user_id === header.creatorUserId
      && row.project_id === header.projectId
      && row.parent_session_id === header.parentSessionId
      && row.root_session_id === header.rootSessionId
      && row.visibility === header.visibility
      && row.session_format_version === header.sessionFormatVersion
      && Number(row.created_at_ms) === header.createdAt
      && row.cwd === header.cwd
      && (row.seed_length === null ? null : Number(row.seed_length)) === header.seedLength
      && row.origin === header.origin
      && row.delegation_depth === header.delegationDepth
      && row.agent_preset === header.agentPreset
      && row.draft === header.draft
      && row.title === header.title
    if (!same) throw new Error(`conversation session ${header.id} already exists with different metadata`)
  }

  private async ensureMaterialized(client: PoolClient, input: ConversationHeader): Promise<StoredHeaderRow> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conversation:${input.id}`])
    const header = await this.resolveHeader(client, input)
    const existing = await client.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions WHERE id=$1 FOR UPDATE`, [header.id])
    const row = existing.rows[0]
    if (row !== undefined) {
      this.assertSameHeader(row, header)
      return row
    }
    await client.query(`INSERT INTO harness.conversation_sessions(
      id,organization_id,creator_user_id,project_id,parent_session_id,root_session_id,visibility,
      session_format_version,created_at,updated_at,cwd,seed_length,origin,delegation_depth,agent_preset,draft,title
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),to_timestamp($9/1000.0),$10,$11,$12,$13,$14,$15,$16)`, [
      header.id, header.organizationId, header.creatorUserId, header.projectId,
      header.parentSessionId, header.rootSessionId, header.visibility, header.sessionFormatVersion, header.createdAt,
      header.cwd, header.seedLength, header.origin, header.delegationDepth, header.agentPreset,
      header.draft ?? false, header.title,
    ])
    const inserted = await client.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions WHERE id=$1 FOR UPDATE`, [header.id])
    const insertedRow = inserted.rows[0]
    if (insertedRow === undefined) throw new Error(`conversation session ${header.id} was not materialized`)
    return insertedRow
  }

  /** Create one session idempotently when its complete metadata is unchanged. */
  async create(header: ConversationHeader): Promise<void> {
    await transaction(this.pool, async client => { await this.ensureMaterialized(client, header) })
  }

  /** Reserve one browser draft id and return its canonical Session id. */
  async reserveDraft(input: ConversationDraftReservationInput): Promise<ConversationDraftReservation> {
    if (input.organizationId === '' || input.scopeKey === '' || input.draftId === '' || input.sessionId === '') {
      throw new Error('draft reservation identifiers must be non-empty')
    }
    if (input.cwd === '') throw new Error('draft reservation cwd must be non-empty')
    if (input.userId === undefined && input.projectId === undefined) {
      throw new Error('draft reservation requires an owner')
    }
    if ((input.projectId === undefined && input.visibility !== 'personal')
      || (input.projectId !== undefined && input.visibility !== 'project' && input.visibility !== 'private')) {
      throw new Error('draft reservation has invalid scope visibility')
    }
    return await transaction(this.pool, async client => {
      await client.query(
        `DELETE FROM harness.conversation_draft_reservations
         WHERE organization_id=$1 AND lease_expires_at <= now()`,
        [input.organizationId],
      )
      const existing = await client.query<{
        session_id: string
        user_id: string | null
        project_id: string | null
        cwd: string
        visibility: ConversationVisibility
        agent_preset: string | null
      }>(`SELECT session_id,user_id,project_id,cwd,visibility,agent_preset
          FROM harness.conversation_draft_reservations
          WHERE organization_id=$1 AND scope_key=$2 AND draft_id=$3 FOR UPDATE`,
      [input.organizationId, input.scopeKey, input.draftId])
      const row = existing.rows[0]
      if (row !== undefined) {
        if (row.user_id !== (input.userId ?? null)
          || row.project_id !== (input.projectId ?? null)
          || row.cwd !== input.cwd
          || row.visibility !== input.visibility
          || row.agent_preset !== (input.agentPreset ?? null)) {
          throw new Error(`draft reservation "${input.draftId}" conflicts with its existing scope`)
        }
        const renewed = await client.query<{ lease_expires_at_ms: string }>(`UPDATE harness.conversation_draft_reservations
          SET updated_at=now(),lease_expires_at=now()+interval '1 hour'
          WHERE organization_id=$1 AND scope_key=$2 AND draft_id=$3
          RETURNING (extract(epoch FROM lease_expires_at)*1000)::bigint::text lease_expires_at_ms`,
        [input.organizationId, input.scopeKey, input.draftId])
        return {
          draftId: input.draftId,
          sessionId: row.session_id,
          leaseExpiresAt: Number(renewed.rows[0]!.lease_expires_at_ms),
          created: false,
        }
      }
      const sessionCollision = await client.query<{ draft_id: string }>(`SELECT draft_id
        FROM harness.conversation_draft_reservations
        WHERE organization_id=$1 AND session_id=$2 FOR UPDATE`, [input.organizationId, input.sessionId])
      if (sessionCollision.rows[0] !== undefined) {
        throw new Error(`session "${input.sessionId}" is already reserved by another draft`)
      }
      const inserted = await client.query<{ lease_expires_at_ms: string }>(`INSERT INTO harness.conversation_draft_reservations(
        organization_id,scope_key,draft_id,session_id,user_id,project_id,cwd,visibility,agent_preset,lease_expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour')
      RETURNING (extract(epoch FROM lease_expires_at)*1000)::bigint::text lease_expires_at_ms`, [
        input.organizationId, input.scopeKey, input.draftId, input.sessionId,
        input.userId ?? null, input.projectId ?? null, input.cwd, input.visibility, input.agentPreset ?? null,
      ])
      return {
        draftId: input.draftId,
        sessionId: input.sessionId,
        leaseExpiresAt: Number(inserted.rows[0]!.lease_expires_at_ms),
        created: true,
      }
    })
  }

  /** Renew a draft lease; missing or mismatched reservations are idempotent false results. */
  async heartbeatDraft(organizationId: string, scopeKey: string, draftId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE harness.conversation_draft_reservations
      SET updated_at=now(),lease_expires_at=now()+interval '1 hour'
      WHERE organization_id=$1 AND scope_key=$2 AND draft_id=$3 AND session_id=$4 AND lease_expires_at > now()`,
    [organizationId, scopeKey, draftId, sessionId])
    return (result.rowCount ?? 0) > 0
  }

  /** Renew a reservation only when it belongs to the authenticated runtime owner. */
  async heartbeatDraftForOwner(input: {
    organizationId: string
    draftId: string
    sessionId: string
    userId?: string
    projectId?: string
  }): Promise<boolean> {
    const result = await this.pool.query(`UPDATE harness.conversation_draft_reservations
      SET updated_at=now(),lease_expires_at=now()+interval '1 hour'
      WHERE organization_id=$1 AND draft_id=$2 AND session_id=$3
        AND lease_expires_at > now()
        AND (($4::uuid IS NOT NULL AND user_id=$4 AND project_id IS NULL)
          OR ($5::uuid IS NOT NULL AND project_id=$5 AND ($4::uuid IS NULL OR user_id=$4)))`,
    [input.organizationId, input.draftId, input.sessionId, input.userId ?? null, input.projectId ?? null])
    return (result.rowCount ?? 0) > 0
  }

  /** Release one draft lease after materialization or abandonment. */
  async releaseDraft(organizationId: string, scopeKey: string, draftId: string, sessionId?: string): Promise<void> {
    await this.pool.query(`DELETE FROM harness.conversation_draft_reservations
      WHERE organization_id=$1 AND scope_key=$2 AND draft_id=$3
        AND ($4::text IS NULL OR session_id=$4)`, [organizationId, scopeKey, draftId, sessionId ?? null])
  }

  /** Release a reservation only when it belongs to the authenticated runtime owner. */
  async releaseDraftForOwner(input: {
    organizationId: string
    draftId: string
    sessionId: string
    userId?: string
    projectId?: string
  }): Promise<void> {
    await this.pool.query(`DELETE FROM harness.conversation_draft_reservations
      WHERE organization_id=$1 AND draft_id=$2 AND session_id=$3
        AND (($4::uuid IS NOT NULL AND user_id=$4 AND project_id IS NULL)
          OR ($5::uuid IS NOT NULL AND project_id=$5 AND ($4::uuid IS NULL OR user_id=$4)))`,
    [input.organizationId, input.draftId, input.sessionId, input.userId ?? null, input.projectId ?? null])
  }

  /** Release every reservation that points at a materialized session. */
  async releaseDraftForSession(organizationId: string, sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM harness.conversation_draft_reservations WHERE organization_id=$1 AND session_id=$2', [organizationId, sessionId])
  }

  /** Append one contiguous batch. Retrying the same batch id and bytes is idempotent. */
  async append(
    sessionId: string,
    batchId: string,
    events: readonly ConversationEvent[],
    header?: ConversationHeader,
  ): Promise<'inserted' | 'duplicate'> {
    if (events.length === 0) return 'inserted'
    for (let index = 0; index < events.length; index++) {
      if (events[index]!.seq !== events[0]!.seq + index) throw new Error('conversation event batch must be contiguous')
    }
    for (const event of events) assertSafeAssistantEvent(event)
    const encodedEvents = events.map(event => {
      const json = serialized(event)
      return { event, json, payloadBytes: Buffer.byteLength(json, 'utf8') }
    })
    // The event envelopes were serialized once for insertion. JSON arrays use
    // the same comma-separated representation, so hash those bytes directly
    // instead of joining a second full-size batch string in memory.
    const checksum = createHash('sha256').update('[')
    for (const [index, { json }] of encodedEvents.entries()) {
      if (index > 0) checksum.update(',')
      checksum.update(json)
    }
    const batchChecksum = checksum.update(']').digest()
    return transaction(this.pool, async (client) => {
      // Batch ids are globally idempotent. Serialize equal ids even when a bad
      // caller reuses one across sessions; hash collisions only reduce concurrency.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [batchId])
      if (header !== undefined && header.id !== sessionId) throw new Error('conversation append header id mismatch')
      // The first append atomically materializes its header. Later appends lock
      // the existing row before reading the idempotency marker and cursor.
      let sessionRow: StoredHeaderRow | undefined
      if (header === undefined) {
        const lineage = await client.query<{ organization_id: string; root_session_id: string }>(`SELECT
          c.organization_id,c.root_session_id FROM harness.conversation_sessions c
          JOIN harness.conversation_sessions r ON r.id=c.root_session_id AND r.organization_id=c.organization_id
          WHERE c.id=$1 AND c.status<>'deleted' AND r.status<>'deleted'`, [sessionId])
        const scope = lineage.rows[0]
        if (scope !== undefined) {
          const root = await client.query(`SELECT id FROM harness.conversation_sessions
            WHERE id=$1 AND organization_id=$2 AND status<>'deleted' FOR UPDATE`,
          [scope.root_session_id, scope.organization_id])
          if (root.rows[0] !== undefined) {
            sessionRow = (await client.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
              FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted' FOR UPDATE`, [sessionId])).rows[0]
          }
        }
      } else {
        sessionRow = await this.ensureMaterialized(client, header)
      }
      if (sessionRow === undefined) throw new Error(`unknown conversation session ${sessionId}`)
      const duplicate = await client.query<{
        session_id: string; first_seq: string; event_count: number; checksum: Buffer
      }>('SELECT session_id,first_seq,event_count,checksum FROM harness.conversation_append_batches WHERE batch_id=$1', [batchId])
      if (duplicate.rows[0] !== undefined) {
        const row = duplicate.rows[0]
        if (row.session_id !== sessionId || Number(row.first_seq) !== events[0]!.seq
          || row.event_count !== events.length || !row.checksum.equals(batchChecksum)) {
          throw new Error('conversation batch id reused with different content')
        }
        return 'duplicate'
      }
      const expected = Number(sessionRow.next_seq)
      if (events[0]!.seq !== expected) throw new Error(`conversation append expected seq ${String(expected)}, got ${String(events[0]!.seq)}`)

      let bytes = 0
      let hasVisibleContent = sessionRow.has_visible_content
      let visibleContentSeq = sessionRow.visible_content_seq === null ? null : Number(sessionRow.visible_content_seq)
      let lastPromptAt = sessionRow.last_prompt_at_ms === null ? null : Number(sessionRow.last_prompt_at_ms)
      const contributions = new Map<number, { count: number; first: number; last: number }>()
      const searchRows: ConversationSearchInsertRow[] = []
      for (const { event, json, payloadBytes } of encodedEvents) {
        bytes += payloadBytes
        const search = eventText(event)
        if (search !== undefined && search.content !== '') {
          searchRows.push({ role: search.role, content: search.content, seq: event.seq, time: event.time })
        }
        if (eventHasVisibleContent(event)) {
          hasVisibleContent = true
          visibleContentSeq = Math.max(visibleContentSeq ?? -1, event.seq)
        }
        const promptTime = eventPromptTime(event)
        if (promptTime !== undefined) lastPromptAt = Math.max(lastPromptAt ?? 0, promptTime)
        const contributor = participantUserId(event)
        if (contributor !== undefined) {
          const current = contributions.get(contributor)
          contributions.set(contributor, current === undefined
            ? { count: 1, first: event.time, last: event.time }
            : { count: current.count + 1, first: Math.min(current.first, event.time), last: Math.max(current.last, event.time) })
        }
      }
      await insertConversationEvents(client, sessionId, encodedEvents)
      await insertConversationSearch(client, sessionId, searchRows)
      for (const [publicUserId, contribution] of contributions) {
        let writer: { id: string; administrator: boolean } | undefined
        if (sessionRow.project_id === null) {
          const user = await client.query<{ id: string }>(`SELECT u.id FROM harness.users u
              WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active'
              FOR SHARE OF u`, [sessionRow.organization_id, publicUserId])
          const id = user.rows[0]?.id
          writer = id === undefined ? undefined : { id, administrator: false }
        } else {
          writer = await this.projectWriter(client, sessionRow.organization_id, sessionRow.project_id, { publicId: publicUserId })
        }
        const contributorId = writer?.id
        if (contributorId === undefined) {
          throw new Error(`conversation contributor ${String(publicUserId)} is not an active rw project member`)
        }
        if (sessionRow.visibility === 'private' && contributorId !== sessionRow.creator_user_id && writer?.administrator !== true) {
          throw new Error(`private conversation ${sessionRow.root_session_id} rejects another contributor`)
        }
        await client.query(`INSERT INTO harness.conversation_participants(
          organization_id,conversation_id,user_id,first_contributed_at,last_contributed_at,contribution_count
        ) VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6)
        ON CONFLICT(conversation_id,user_id) DO UPDATE SET
          first_contributed_at=LEAST(harness.conversation_participants.first_contributed_at,excluded.first_contributed_at),
          last_contributed_at=GREATEST(harness.conversation_participants.last_contributed_at,excluded.last_contributed_at),
          contribution_count=harness.conversation_participants.contribution_count+excluded.contribution_count`,
        [sessionRow.organization_id, sessionRow.root_session_id, contributorId,
          contribution.first, contribution.last, contribution.count])
      }
      await client.query(`UPDATE harness.conversation_sessions SET
        next_seq=$2,event_count=event_count+$3,total_payload_bytes=total_payload_bytes+$4,
        has_visible_content=$5,visible_content_seq=$6,last_prompt_at=CASE
          WHEN $7::bigint IS NULL THEN last_prompt_at
          WHEN last_prompt_at IS NULL THEN to_timestamp($7/1000.0)
          ELSE GREATEST(last_prompt_at,to_timestamp($7/1000.0))
        END,draft=CASE WHEN $5 THEN false ELSE draft END,
        updated_at=now(),version=version+1 WHERE id=$1`,
      [sessionId, events.at(-1)!.seq + 1, events.length, bytes,
        hasVisibleContent, visibleContentSeq, lastPromptAt])
      if (sessionRow.root_session_id !== sessionId) {
        await client.query(`UPDATE harness.conversation_sessions SET
          has_visible_content=has_visible_content OR $2,
          draft=CASE WHEN $2 THEN false ELSE draft END,
          visible_content_seq=CASE WHEN $2 THEN GREATEST(COALESCE(visible_content_seq,-1),$3) ELSE visible_content_seq END,
          last_prompt_at=CASE WHEN $4::bigint IS NULL THEN last_prompt_at
            WHEN last_prompt_at IS NULL THEN to_timestamp($4/1000.0)
            ELSE GREATEST(last_prompt_at,to_timestamp($4/1000.0)) END,
          updated_at=now() WHERE id=$1`,
        [sessionRow.root_session_id, hasVisibleContent, visibleContentSeq, lastPromptAt])
      }
      await client.query(`INSERT INTO harness.conversation_append_batches(batch_id,session_id,first_seq,event_count,checksum)
        VALUES($1,$2,$3,$4,$5)`, [batchId, sessionId, events[0]!.seq, events.length, batchChecksum])
      return 'inserted'
    })
  }

  private async readFromWith(
    source: Queryable,
    sessionId: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<ConversationEvent[]> {
    const result = await checkedQuery<{ event: ConversationEvent; seq: string }>(source,
      'SELECT e.seq::text,e.event FROM harness.conversation_events e WHERE e.session_id=$1 AND e.seq >= $2 ORDER BY e.seq',
      [sessionId, fromSeq], signal,
    )
    validateReadRows(result.rows, fromSeq)
    return result.rows.map(row => row.event)
  }

  async readFrom(sessionId: string, fromSeq: number, signal?: AbortSignal): Promise<ConversationEvent[]> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
      throw new ConversationReadError('protocol', 'conversation readFrom seq must be a non-negative safe integer')
    }
    try {
      return await this.readFromWith(this.pool, sessionId, fromSeq, signal)
    } catch (error: unknown) {
      const normalized = normalizeReadError(error, signal)
      if (normalized !== undefined) throw normalized
      throw error
    }
  }

  /** Read one conversation header and revision without touching its event rows. */
  async readHeader(sessionId: string, signal?: AbortSignal): Promise<ConversationHeader | undefined> {
    try {
      const result = await checkedQuery<StoredHeaderRow>(this.pool, `SELECT ${HEADER_COLUMNS}
        FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted'`, [sessionId], signal)
      const row = result.rows[0]
      return row === undefined ? undefined : headerFromRow(row)
    } catch (error: unknown) {
      const normalized = normalizeReadError(error, signal)
      if (normalized !== undefined) throw normalized
      throw error
    }
  }

  /**
   * Read bounded turn markers and short previews without loading event
   * payloads. Turn boundaries come from the event-type index; previews come
   * from the already-maintained conversation search rows.
   */
  async readHistoryIndex(
    sessionId: string,
    maxItems = DEFAULT_HISTORY_INDEX_MAX_ITEMS,
    signal?: AbortSignal,
  ): Promise<ConversationHistoryIndex | undefined> {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > DEFAULT_HISTORY_INDEX_MAX_ITEMS) {
      throw new ConversationReadError('protocol', 'conversation history index maxItems is invalid')
    }
    try {
      return await transaction(this.pool, async (client) => {
        await checkedQuery(client, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], signal)
        const headerResult = await checkedQuery<StoredHeaderRow>(client, `SELECT ${HEADER_COLUMNS}
          FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted'`, [sessionId], signal)
        const headerRow = headerResult.rows[0]
        if (headerRow === undefined) return undefined
        const nextSeq = Number(headerRow.next_seq)
        if (!Number.isSafeInteger(nextSeq) || nextSeq < 0) {
          throw new ConversationReadError('protocol', 'conversation history index next sequence is invalid')
        }
        const starts = await checkedQuery<HistoryIndexStartRow>(client, `WITH raw AS (
            SELECT e.seq,
              CASE WHEN position(chr(92) || '\\u0000' IN e.event::text) > 0 THEN NULL
                WHEN json_typeof(e.event->'data'->'turn')='number'
                AND (e.event->'data'->>'turn') ~ '^[0-9]+$'
                THEN (e.event->'data'->>'turn')::bigint ELSE NULL END AS turn
            FROM harness.conversation_events e
            WHERE e.session_id=$1 AND e.event_type='turn/start'
          ), indexed AS (
            SELECT seq,turn,
              lead(seq,1,$2::bigint) OVER (ORDER BY seq)-1 AS end_seq,
              row_number() OVER (ORDER BY seq)-1 AS ordinal,
              count(*) OVER () AS total
            FROM raw WHERE turn IS NOT NULL
          )
          SELECT seq::text AS start_seq,end_seq::text,turn::text,
            ordinal::text,total::text
          FROM indexed
          WHERE total <= $3::bigint
            OR ordinal=0 OR ordinal=total-1
            OR ordinal % GREATEST(1,ceil(total::numeric/$3::numeric)::bigint)=0
          ORDER BY seq`, [sessionId, nextSeq, maxItems], signal)
        const totalTurns = starts.rows.length === 0 ? 0 : Number(starts.rows[0]!.total)
        if (!Number.isSafeInteger(totalTurns) || totalTurns < 0) {
          throw new ConversationReadError('protocol', 'conversation history index turn count is invalid')
        }
        const items = starts.rows.map((row): ConversationHistoryIndexItem => {
          const startSeq = Number(row.start_seq)
          const endSeq = Number(row.end_seq)
          const turn = Number(row.turn)
          if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)
            || !Number.isSafeInteger(turn) || startSeq < 0 || endSeq < startSeq || turn < 0) {
            throw new ConversationReadError('protocol', 'conversation history index row is invalid')
          }
          return { turn, startSeq, endSeq }
        })
        // `conversation_search` does not persist a turn number. Its sequence
        // range is exact only when every turn marker was returned; sampled
        // indexes therefore omit previews rather than reading event JSON (a
        // valid escaped NUL in a JSON column makes PostgreSQL JSON operators
        // reject the whole row with 22P05).
        if (items.length > 0 && items.length === totalTurns) {
          const first = items[0]!
          const last = items.at(-1)!
          const search = await checkedQuery<HistoryIndexSearchRow>(client, `SELECT event_seq::text,role,
              left(content,320) AS content
            FROM harness.conversation_search
            WHERE session_id=$1 AND role IN ('user','assistant')
              AND event_seq >= $2 AND event_seq <= $3
            ORDER BY event_seq LIMIT $4`, [sessionId, first.startSeq, last.endSeq, MAX_HISTORY_INDEX_SEARCH_ROWS], signal)
          for (const row of search.rows) {
            const seq = Number(row.event_seq)
            if (!Number.isSafeInteger(seq) || seq < 0) continue
            let low = 0
            let high = items.length - 1
            let found = -1
            while (low <= high) {
              const middle = low + Math.floor((high - low) / 2)
              const candidate = items[middle]!
              if (seq < candidate.startSeq) high = middle - 1
              else if (seq > candidate.endSeq) low = middle + 1
              else { found = middle; break }
            }
            if (found < 0) continue
            const preview = historyIndexPreview(row.content)
            if (preview === undefined) continue
            const item = items[found]!
            if (row.role === 'user' && item.prompt === undefined) item.prompt = preview
            if (row.role === 'assistant') item.response = preview
          }
        }
        return {
          revision: `${headerRow.version}:${headerRow.next_seq}`,
          asOfSeq: nextSeq - 1,
          totalTurns,
          items,
          truncated: items.length < totalTurns,
        }
      }, signal)
    } catch (error: unknown) {
      const normalized = normalizeReadError(error, signal)
      if (normalized !== undefined) throw normalized
      throw error
    }
  }

  /**
   * Read a bounded conversation page using the `(session_id, seq)` index.
   * Header and event rows are selected in one repeatable-read snapshot so a
   * continuation cursor never mixes two revisions.
   */
  async readPage(
    sessionId: string,
    request: ConversationPageRequest = {},
    signal?: AbortSignal,
  ): Promise<ConversationPage | undefined> {
    const direction = pageDirection(request)
    const beforeSeq = optionalSeq('beforeSeq', request.beforeSeq)
    const fromSeq = optionalSeq('fromSeq', request.fromSeq)
    if (request.cursor !== undefined && (beforeSeq !== undefined || fromSeq !== undefined)) {
      throw new ConversationReadError('protocol', 'conversation page cursor cannot be combined with a sequence anchor')
    }
    if (direction === 'older' && fromSeq !== undefined) {
      throw new ConversationReadError('protocol', 'older conversation pages cannot use fromSeq')
    }
    if (direction === 'newer' && beforeSeq !== undefined) {
      throw new ConversationReadError('protocol', 'newer conversation pages cannot use beforeSeq')
    }
    const maxBytes = positiveLimit('maxBytes', request.maxBytes, DEFAULT_PAGE_MAX_BYTES)
    const maxEvents = positiveLimit('maxEvents', request.maxEvents, DEFAULT_PAGE_MAX_EVENTS)
    const maxGroups = positiveLimit('maxGroups', request.maxGroups, DEFAULT_PAGE_MAX_GROUPS)
    const queryLimit = Math.min(MAX_PAGE_QUERY_EVENTS, maxEvents + 1)
    assertSignal(signal)
    try {
      return await transaction(this.pool, async (client) => {
        await checkedQuery(client, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], signal)
        const headerResult = await checkedQuery<StoredHeaderRow>(client, `SELECT ${HEADER_COLUMNS}
          FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted'`, [sessionId], signal)
        const headerRow = headerResult.rows[0]
        if (headerRow === undefined) return undefined
        const header = headerFromRow(headerRow)
        const revision = `${headerRow.version}:${headerRow.next_seq}`
        let anchor: number
        if (request.cursor !== undefined) {
          const cursor = decodePageCursor(request.cursor)
          if (cursor.sessionId !== sessionId || cursor.direction !== direction) {
            throw new ConversationReadError('protocol', 'conversation page cursor belongs to another request')
          }
          // A moved log is the same transient condition as a revision change
          // inside one page read; the Host retries `dependency`, never `protocol`.
          if (cursor.revision !== revision) {
            throw new ConversationReadError('dependency', 'conversation revision changed since the page cursor was issued')
          }
          anchor = cursor.anchor
        } else if (direction === 'older') {
          anchor = beforeSeq ?? Number(headerRow.next_seq)
        } else {
          anchor = fromSeq ?? 0
        }
        const query = direction === 'older'
          ? `SELECT e.seq::text,e.event,e.payload_bytes FROM harness.conversation_events e
            WHERE e.session_id=$1 AND e.seq < $2 ORDER BY e.seq DESC LIMIT $3`
          : `SELECT e.seq::text,e.event,e.payload_bytes FROM harness.conversation_events e
            WHERE e.session_id=$1 AND e.seq >= $2 ORDER BY e.seq ASC LIMIT $3`
        const result = await checkedQuery<ConversationEventRow>(client, query, [sessionId, anchor, queryLimit], signal)
        const rows = direction === 'older' ? [...result.rows].reverse() : result.rows
        validatePageAnchor(rows, direction, anchor, Number(headerRow.next_seq))
        const selected = selectPageRows(rows, direction, maxBytes, maxEvents, maxGroups)
        validatePageRows(selected.rows)
        const first = selected.rows[0]
        const last = selected.rows.at(-1)
        const hasMore = selected.hasMore
          || (direction === 'older' ? (first !== undefined && Number(first.seq) > 0) : (last !== undefined && Number(last.seq) < Number(headerRow.next_seq) - 1))
        const nextAnchor = direction === 'older'
          ? (first === undefined ? anchor : Number(first.seq))
          : (last === undefined ? anchor : Number(last.seq) + 1)
        const nextCursor = hasMore
          ? encodePageCursor({ version: 1, sessionId, revision, direction, anchor: nextAnchor })
          : undefined
        return {
          header,
          events: selected.rows.map(row => row.event),
          revision,
          startSeq: first === undefined ? null : Number(first.seq),
          endSeq: last === undefined ? null : Number(last.seq),
          hasMore,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          uncompressedBytes: selected.bytes,
        }
      }, signal)
    } catch (error: unknown) {
      const normalized = normalizeReadError(error, signal)
      if (normalized !== undefined) throw normalized
      throw error
    }
  }

  /** Read metadata, revision, and events from one PostgreSQL snapshot. */
  async load(sessionId: string): Promise<StoredConversation | undefined> {
    return await transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const header = await client.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
        FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted'`, [sessionId])
      const row = header.rows[0]
      if (row === undefined) return undefined
      return {
        header: headerFromRow(row),
        events: await this.readFromWith(client, sessionId, 0),
        revision: `${row.version}:${row.next_seq}`,
      }
    })
  }

  async revision(sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const result = await checkedQuery<{ version: string; next_seq: string }>(this.pool, `SELECT version::text,next_seq::text
        FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted'`, [sessionId], signal)
      const row = result.rows[0]
      return row === undefined ? undefined : `${row.version}:${row.next_seq}`
    } catch (error: unknown) {
      const normalized = normalizeReadError(error, signal)
      if (normalized !== undefined) throw normalized
      throw error
    }
  }

  async list(organizationId: string, projectId?: string): Promise<ConversationHeader[]> {
    const result = await this.pool.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions
      WHERE organization_id=$1 AND status<>'deleted'
        AND (($2::uuid IS NULL AND project_id IS NULL) OR project_id=$2)
      ORDER BY updated_at DESC,id`, [organizationId, projectId ?? null])
    return result.rows.map(headerFromRow)
  }

  async listScoped(scope: {
    organizationId: string
    projectId?: string
    creatorUserId?: string
  }): Promise<ConversationListSnapshot[]> {
    const result = await this.pool.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions
      WHERE organization_id=$1 AND status<>'deleted'
        AND (($2::uuid IS NULL AND project_id IS NULL) OR project_id=$2)
        AND ($3::uuid IS NULL OR creator_user_id=$3)
      ORDER BY updated_at DESC,id`, [scope.organizationId, scope.projectId ?? null, scope.creatorUserId ?? null])
    return result.rows.map(row => ({
      header: headerFromRow(row),
      revision: `${row.version}:${row.next_seq}`,
      content: {
        blank: !row.has_visible_content,
        visibleContentSeq: row.visible_content_seq === null ? null : Number(row.visible_content_seq),
        lastPromptAt: row.last_prompt_at_ms === null ? null : Number(row.last_prompt_at_ms),
      },
    }))
  }

  async search(organizationId: string, query: string, limit = 50): Promise<Array<{ sessionId: string; seq: number; content: string }>> {
    const result = await this.pool.query<{ session_id: string; event_seq: string; content: string }>(`SELECT s.session_id,s.event_seq,s.content
      FROM harness.conversation_search s
      JOIN harness.conversation_sessions c ON c.id=s.session_id
      WHERE c.organization_id=$1 AND s.content % $2
      ORDER BY similarity(s.content,$2) DESC,s.occurred_at DESC LIMIT $3`, [organizationId, query, limit])
    return result.rows.map(row => ({ sessionId: row.session_id, seq: Number(row.event_seq), content: row.content }))
  }

  /** Remove one root conversation tree and return owned file paths for cleanup. */
  async removeTree(organizationId: string, rootSessionId: string): Promise<string[]> {
    return await transaction(this.pool, async client => {
      const files = await client.query<{ local_path: string }>(`SELECT f.local_path
        FROM harness.content_files f
        JOIN harness.conversation_sessions s ON s.id=f.session_id AND s.organization_id=f.organization_id
        WHERE f.organization_id=$1 AND s.root_session_id=$2`, [organizationId, rootSessionId])
      await client.query(`DELETE FROM harness.content_files WHERE organization_id=$1 AND session_id IN
        (SELECT id FROM harness.conversation_sessions WHERE organization_id=$1 AND root_session_id=$2)`, [organizationId, rootSessionId])
      await client.query(`DELETE FROM harness.conversation_draft_reservations
        WHERE organization_id=$1 AND session_id IN
          (SELECT id FROM harness.conversation_sessions WHERE organization_id=$1 AND root_session_id=$2)`,
      [organizationId, rootSessionId])
      await client.query(`DELETE FROM harness.conversation_sessions WHERE organization_id=$1 AND root_session_id=$2`, [organizationId, rootSessionId])
      return files.rows.map(row => row.local_path)
    })
  }
}
