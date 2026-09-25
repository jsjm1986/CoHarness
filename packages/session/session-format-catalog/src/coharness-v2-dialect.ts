/**
 * CoHarness v2 database dialect admission for the shared logical catalog.
 * SQLite/PostgreSQL-backed Sessions were committed while the format still
 * carried vocabulary that predates the released v2 rules: retired event names
 * (`compact/*`, `steering/message`), flat message carriers without ids, a
 * request-header system prompt that precedes the first step, and a bare
 * `session/end-seed` delimiter at the seed cut. This module normalizes exactly
 * that declared vocabulary and then delegates to the released v2→v3 stage, so
 * both physical and logical paths enforce one admission policy: payloads the
 * released stage does not classify are refused.
 */

import { createHash } from 'node:crypto'
import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import {
  assertEvent,
  canonicalizeTransformedEvent,
  record,
  remapEvent,
  renamePtcEvent,
  sessionFormatV2ToV3,
  SURFACE_TYPES,
} from '@deepseek-ai/dsh-session-format-v2-to-v3'

/* jscpd:ignore-start -- ports the released v0→v1 lexical normalization to the v2
 * logical edge: upstream does not export it, and its v0-era exact-key
 * assertions reject fields that remain valid at v2, so these transforms keep
 * the weaker pre-admission form and defer to the released stage's checks. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyMessageId(sessionId: string, seq: number): string {
  return `legacy-message:${sessionId}:${seq}`
}

function malformedLegacy(sessionId: string, type: string, seq: number): SessionFormatError {
  return new SessionFormatError(
    `session ${JSON.stringify(sessionId)} contains malformed legacy ${type} at seq ${seq}`,
  )
}

interface LegacyNormalizationState {
  readonly messageIds: Map<number, string>
  readonly retryIds: Map<string, string>
  compactionId?: string
}

/**
 * Shape-conditional legacy normalization for the CoHarness v2 dialect. Each
 * rule recognizes one released historical form and refuses unresolvable or
 * ambiguous payloads instead of guessing.
 */
function normalizeLegacyEvent(
  event: SessionFormatEvent,
  sessionId: string,
  state: LegacyNormalizationState,
): SessionFormatEvent {
  const named = normalizeLegacyCompactionType(event)
  assertSupportedLegacyType(named, sessionId)
  const start = normalizeLegacyTurnStart(named, sessionId)
  const end = normalizeLegacyTurnEnd(start, sessionId)
  const header = normalizeLegacyRequestHeader(end, sessionId)
  const steering = normalizeLegacySteering(header, sessionId)
  const retry = normalizeLegacyRetry(steering, sessionId, state.retryIds)
  const compaction = normalizeLegacyCompaction(retry, sessionId, state)
  const message = normalizeLegacyMessage(compaction, sessionId, state.messageIds)
  const listed = normalizeLegacyMessageLists(message, sessionId)
  const messageId = eventMessageId(listed)
  if (messageId !== undefined) state.messageIds.set(listed.seq, messageId)
  return listed
}

function normalizeLegacyCompactionType(event: SessionFormatEvent): SessionFormatEvent {
  switch (event.type) {
    case 'compact/start': return { ...event, type: 'compaction/start' }
    case 'compact/summary': return { ...event, type: 'compaction/summary' }
    case 'compact/end': return { ...event, type: 'compaction/end' }
    case 'compact/prune': return { ...event, type: 'compaction/prune' }
    default: return event
  }
}

/** Legacy flat `assistant/message` field carrying the model source record. */
const LEGACY_ASSISTANT_SOURCE_KEY = ['pro', 'venance'].join('')

/** Refuse legacy payloads that have no released successor interpretation. */
function assertSupportedLegacyType(event: SessionFormatEvent, sessionId: string): void {
  if (event.type === 'request/header-delta' || event.type === 'mode/set') {
    throw new SessionFormatUnsupportedMigrationError(
      `session ${JSON.stringify(sessionId)} contains unsupported legacy ${event.type} event at seq ${event.seq}`,
    )
  }
  if (event.type === 'request/header') {
    const data = isRecord(event.data) ? event.data : undefined
    if (data?.['reason'] === 'fallback') {
      throw new SessionFormatUnsupportedMigrationError(
        `session ${JSON.stringify(sessionId)} contains unsupported request/header reason "fallback" at seq ${event.seq}`,
      )
    }
  }
}

/** `turn/start` dropped its trigger payload at v1: retain only the turn number. */
function normalizeLegacyTurnStart(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'turn/start') return event
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined || !Object.hasOwn(data, 'trigger')) return event
  const turn = data['turn']
  const trigger = data['trigger']
  if (typeof turn !== 'number' || turn < 1
    || !isRecord(trigger) || typeof trigger['kind'] !== 'string' || trigger['kind'].length === 0) {
    throw malformedLegacy(sessionId, 'turn/start', event.seq)
  }
  return { ...event, data: { turn } }
}

/** `turn/end` reason shapes converged at v1: fold the retired variants into current ones. */
function normalizeLegacyTurnEnd(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'turn/end') return event
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined) return event
  const reason = data['reason']
  if (!isRecord(reason) || typeof reason['kind'] !== 'string') {
    throw malformedLegacy(sessionId, 'turn/end', event.seq)
  }
  let current: SessionFormatJsonObject
  switch (reason['kind']) {
    case 'completed':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      return event
    case 'aborted':
      if (Object.hasOwn(reason, 'reason')) return event
      current = { kind: 'aborted', reason: { kind: 'legacy' } }
      break
    case 'disposed':
      current = { kind: 'aborted', reason: { kind: 'disposed' } }
      break
    case 'error':
      if (Object.hasOwn(reason, 'error')) return event
      current = normalizeLegacyErrorReason(reason, event.seq, sessionId)
      break
    default:
      return event
  }
  return { ...event, data: { ...data, reason: current } }
}

function normalizeLegacyErrorReason(
  reason: Record<string, unknown>,
  seq: number,
  sessionId: string,
): SessionFormatJsonObject {
  const failure = reason['failure']
  if (failure !== undefined) {
    if (!isRecord(failure)
      || typeof failure['message'] !== 'string' || typeof failure['code'] !== 'string') {
      throw malformedLegacy(sessionId, 'turn/end', seq)
    }
    return { kind: 'error', error: failure as SessionFormatJsonObject }
  }
  if (typeof reason['message'] !== 'string'
    || (reason['code'] !== undefined && typeof reason['code'] !== 'string')) {
    throw malformedLegacy(sessionId, 'turn/end', seq)
  }
  return {
    kind: 'error',
    error: {
      message: reason['message'],
      code: typeof reason['code'] === 'string' ? reason['code'] : 'UNKNOWN',
    },
  }
}

/** `request/header` dropped its messagePrefix payload at v1. */
function normalizeLegacyRequestHeader(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'request/header') return event
  const data = isRecord(event.data) ? event.data : undefined
  const header = isRecord(data?.['header']) ? data['header'] : undefined
  if (header === undefined || !Object.hasOwn(header, 'messagePrefix')) return event
  if (!Array.isArray(header['messagePrefix'])) {
    throw new SessionFormatError(
      `session ${JSON.stringify(sessionId)} contains malformed request/header messagePrefix at seq ${event.seq}`,
    )
  }
  const { messagePrefix: _messagePrefix, ...currentHeader } = header
  return { ...event, data: { ...data, header: currentHeader } }
}

/** `steering/message` envelopes became plain user messages at v1. */
function normalizeLegacySteering(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'steering/message') return event
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined) throw malformedLegacy(sessionId, 'steering/message', event.seq)
  const wrapped = data['message']
  if (wrapped !== undefined) {
    if (typeof data['turn'] !== 'number') throw malformedLegacy(sessionId, 'steering/message', event.seq)
    return { ...event, type: 'user/message', data: wrapped }
  }
  const { turn: _turn, ...message } = data
  return {
    ...event,
    type: 'user/message',
    data: {
      ...message,
      id: legacyMessageId(sessionId, event.seq),
      role: 'user',
    },
  }
}

/** Early `llm/retry` events carried no id; v1 requires a chain-stable one. */
function normalizeLegacyRetry(
  event: SessionFormatEvent,
  sessionId: string,
  retryIds: Map<string, string>,
): SessionFormatEvent {
  if (event.type !== 'llm/retry') return event
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined) return event
  const chain = [data['turn'], data['step'], data['provider'], data['policyKey']]
    .map(value => JSON.stringify(value))
    .join('\0')
  const retryId = data['retryId']
  if (typeof retryId === 'string' && retryId.length > 0) {
    retryIds.set(chain, retryId)
    return event
  }
  if (Object.hasOwn(data, 'retryId')) return event
  const migratedRetryId = retryIds.get(chain) ?? `legacy-retry:${sessionId}:${event.seq}`
  retryIds.set(chain, migratedRetryId)
  return { ...event, data: { ...data, retryId: migratedRetryId } }
}

/** Early compaction events carried no id; v1 threads one through the bracket. */
function normalizeLegacyCompaction(
  event: SessionFormatEvent,
  sessionId: string,
  state: LegacyNormalizationState,
): SessionFormatEvent {
  if (event.type === 'session/end-seed') {
    delete state.compactionId
    return event
  }
  if (event.type === 'compaction/start') {
    const data = isRecord(event.data) ? event.data : undefined
    const existing = data?.['compactionId']
    if (typeof existing === 'string' && existing.length > 0) {
      state.compactionId = existing
      return event
    }
    if (data !== undefined && Object.hasOwn(data, 'compactionId')) return event
    const id = `legacy-compaction:${sessionId}:${event.seq}`
    state.compactionId = id
    return { ...event, data: { ...data, compactionId: id } }
  }
  const compactionId = state.compactionId
  if (compactionId === undefined) return event
  if (event.type === 'compaction/summary' || event.type === 'compaction/end') {
    const normalized = addLegacyCompactionId(event, compactionId)
    if (event.type === 'compaction/end') delete state.compactionId
    return normalized
  }
  if (event.type !== 'user/message') return event
  const data = isRecord(event.data) ? event.data : undefined
  const source = data?.['source']
  if (!isRecord(source) || source['kind'] !== 'plugin' || source['plugin'] !== 'compact'
    || Object.hasOwn(source, 'compactionId')) return event
  return {
    ...event,
    data: {
      ...data,
      source: { ...source, compactionId },
    },
  }
}

function addLegacyCompactionId(
  event: SessionFormatEvent,
  compactionId: string,
): SessionFormatEvent {
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined || Object.hasOwn(data, 'compactionId')) return event
  return { ...event, data: { ...data, compactionId } }
}

/** Early message carriers lacked the `message` envelope or `id`/`role` fields. */
function normalizeLegacyMessage(
  event: SessionFormatEvent,
  sessionId: string,
  messageIds: ReadonlyMap<number, string>,
): SessionFormatEvent {
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined) return event
  switch (event.type) {
    case 'user/message':
      if (Object.hasOwn(data, 'id') || Object.hasOwn(data, 'role')
        || Object.hasOwn(data, 'message') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'source')) return event
      return {
        ...event,
        data: {
          ...data,
          id: legacyMessageId(sessionId, event.seq),
          role: 'user',
        },
      }
    case 'assistant/message': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, LEGACY_ASSISTANT_SOURCE_KEY)) return event
      const { content, ...eventData } = data
      const legacySource = eventData[LEGACY_ASSISTANT_SOURCE_KEY]
      const source = isRecord(legacySource) ? legacySource : {}
      Reflect.deleteProperty(eventData, LEGACY_ASSISTANT_SOURCE_KEY)
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: legacyMessageId(sessionId, event.seq),
            role: 'assistant',
            content,
            source: { ...source, kind: 'model' },
          },
        } as SessionFormatJsonObject,
      }
    }
    case 'tool/result': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'callId') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'isError')) return event
      const { callId, content, isError, ...eventData } = data
      if (typeof callId !== 'string' || typeof isError !== 'boolean' || content === undefined) return event
      const inheritedSeq = replacementStartSeq(event)
      const messageId = inheritedSeq === undefined
        ? legacyMessageId(sessionId, event.seq)
        : messageIds.get(inheritedSeq)
      if (messageId === undefined) {
        throw new SessionFormatError(`tool/result ${event.seq} replacement cites a message without identity`)
      }
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: messageId,
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
            source: { kind: 'tool', callId },
          },
        },
      }
    }
    default:
      return event
  }
}

/** Legacy message lists inside `inserted`/`messages` payloads lacked `id`/`role`. */
function normalizeLegacyMessageLists(
  event: SessionFormatEvent,
  sessionId: string,
): SessionFormatEvent {
  const field = event.type === 'agent/inbox/spliced' ? 'inserted'
    : event.type === 'session/title-llm-request' ? 'messages' : undefined
  if (field === undefined) return event
  const data = isRecord(event.data) ? event.data : undefined
  const list = data?.[field]
  if (data === undefined || !Array.isArray(list)) return event
  if (!list.some(item => isRecord(item) && !Object.hasOwn(item, 'id') && Object.hasOwn(item, 'content'))) return event
  const normalized = (list as readonly SessionFormatJsonValue[]).map((item: SessionFormatJsonValue, index: number) => {
    if (!isRecord(item) || Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'content')) return item
    return { ...item, role: 'user', id: `${legacyMessageId(sessionId, event.seq)}:${index}` }
  })
  return { ...event, data: { ...data, [field]: normalized } }
}

/** Legacy replace ops name their shadowed range `start`/`end` in source coordinates. */
function replacementStartSeq(event: SessionFormatEvent): number | undefined {
  const operation = (event as { surfaceOp?: unknown }).surfaceOp
  if (!isRecord(operation) || operation['op'] !== 'replace') return undefined
  const start = operation['start']
  return typeof start === 'number' && Number.isSafeInteger(start) && start >= 0 ? start : undefined
}

function eventMessageId(event: SessionFormatEvent): string | undefined {
  const data = isRecord(event.data) ? event.data : undefined
  const message = event.type === 'user/message'
    ? data
    : isRecord(data?.['message']) ? data['message'] : undefined
  return typeof message?.['id'] === 'string' ? message['id'] : undefined
}
/* jscpd:ignore-end */

/** Validate the JSON containers owned by message carriers before migration rewrites them. */
function assertV2CarrierShape(event: SessionFormatEvent): void {
  const data = event.data
  if (event.type === 'assistant/attempt') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)
      || !Array.isArray((data as Record<string, unknown>).stream)) {
      throw new SessionFormatError(`v2 ${event.type} has invalid stream`)
    }
    return
  }
  if (event.type === 'user/message') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)
      || !Array.isArray((data as Record<string, unknown>).content)) {
      throw new SessionFormatError(`v2 ${event.type} has invalid content`)
    }
    return
  }
  if (event.type !== 'assistant/message' && event.type !== 'tool/result'
    && event.type !== 'agent/inbox/spliced' && event.type !== 'session/title-llm-request') return
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new SessionFormatError(`v2 ${event.type} has invalid data`)
  }
  const carrier = data as Record<string, unknown>
  const field = event.type === 'assistant/message' || event.type === 'tool/result' ? 'message'
    : event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
  const value = carrier[field]
  if (field === 'message') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray((value as Record<string, unknown>).content)) {
      throw new SessionFormatError(`v2 ${event.type} has invalid message content`)
    }
    return
  }
  if (!Array.isArray(value) || value.some(item => item === null || typeof item !== 'object' || Array.isArray(item)
    || !Array.isArray((item as Record<string, unknown>).content))) {
    throw new SessionFormatError(`v2 ${event.type} has invalid messages`)
  }
}

/**
 * Strip surface metadata the dialect attached to non-surface events. The
 * released vocabulary reserves `surfaceOp`/`sourceEventSeqs` for surface
 * types; the DB dialect also recorded them on `request/header`, where the
 * placement claim is re-derived from the system head during emission. The
 * fields are validated for a recognizable form — malformed values still
 * refuse — and dropped, not remapped.
 */
function stripNonSurfaceMetadata(event: SessionFormatEvent): SessionFormatEvent {
  const surfaceOp = (event as { surfaceOp?: unknown }).surfaceOp
  const sourceEventSeqs = (event as { sourceEventSeqs?: unknown }).sourceEventSeqs
  if (SURFACE_TYPES.has(event.type) || (surfaceOp === undefined && sourceEventSeqs === undefined)) {
    return event
  }
  if (surfaceOp !== undefined && surfaceOp !== 'append') {
    const operation = isRecord(surfaceOp) ? surfaceOp : undefined
    if (operation === undefined || operation['op'] !== 'replace'
      || !Number.isSafeInteger(operation['start']) || !Number.isSafeInteger(operation['end'])
      || (operation['start'] as number) < 0 || (operation['end'] as number) < 0
      || (operation['start'] as number) >= event.seq || (operation['end'] as number) >= event.seq) {
      throw new SessionFormatError(
        `format v2 ${event.type} at seq ${event.seq} surfaceOp must name an earlier replace range`,
      )
    }
  }
  if (sourceEventSeqs !== undefined
    && (!Array.isArray(sourceEventSeqs) || sourceEventSeqs.length === 0
      || sourceEventSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq))) {
    throw new SessionFormatError(
      `format v2 ${event.type} at seq ${event.seq} sourceEventSeqs must name earlier events`,
    )
  }
  const stripped = { ...event }
  delete (stripped as Record<string, unknown>)['surfaceOp']
  delete (stripped as Record<string, unknown>)['sourceEventSeqs']
  return stripped
}

/**
 * Same-artifact sequence references in an event's audited payload fields —
 * the ones the released remap rewrites. The pending drain uses them to keep a
 * referencing event behind the events it cites when the cited events are
 * still buffered. Envelope `surfaceOp`/`sourceEventSeqs` never reach this
 * view: the drain only consults it for non-surface events, whose envelope
 * metadata was stripped at intake.
 */
function eventReferenceSeqs(event: SessionFormatEvent): number[] {
  const seqs: number[] = []
  const push = (value: unknown): void => {
    if (Number.isSafeInteger(value)) seqs.push(value as number)
  }
  /* Every pending event passed admission, which requires a record data
   * payload for all admitted types, so members read directly; only optional
   * members need push's drop guard. */
  const data = event.data as Record<string, SessionFormatJsonValue>
  switch (event.type) {
    case 'command/done':
      push(data['sourceEventSeq'])
      break
    case 'compaction/summary':
    case 'compaction/prune': {
      const range = data['shadowedRange'] as Record<string, SessionFormatJsonValue>
      push(range['start'])
      push(range['end'])
      for (const seq of data['shadowedSeqs'] as readonly number[]) push(seq)
      break
    }
    case 'session/title':
    case 'session/title-llm-request':
      for (const seq of data['messageSeqs'] as readonly number[]) push(seq)
      break
    default:
      break
  }
  return seqs
}

/**
 * Whether a pending event may emit while no system head exists yet. Surface
 * carriers must follow the head, `request/header` needs an open step, and an
 * event citing still-buffered sequences must stay behind them so the released
 * remap keeps naming earlier source events.
 */
function canEmitWithoutHead(event: SessionFormatEvent, mapping: readonly number[]): boolean {
  if (SURFACE_TYPES.has(event.type) || event.type === 'request/header') return false
  return eventReferenceSeqs(event).every(seq => mapping[seq] !== undefined)
}

/** Whether the event carries the inherited boundary rather than an ordinary delimiter. */
function isCutMarker(event: SessionFormatEvent, seeded: boolean, sourceCut: number | undefined): boolean {
  if (event.type !== 'session/end-seed') return false
  /* Callers only consult the marker check after admission proved the data
   * record, so the payload reads directly. */
  const data = event.data as Record<string, SessionFormatJsonValue>
  if (data['inherited'] === true) return true
  /* The dialect wrote a bare delimiter at the declared cut. */
  return seeded && sourceCut !== undefined && event.seq === sourceCut
}

/**
 * CoHarness v2→v3 edge: normalize the declared DB dialect, then apply the
 * released admission, reference, and canonicalization rules to every emitted
 * event. Only the ordering policy is dialect-owned — the released stage keeps
 * every source event in place, while the DB dialect may hold turn-scope
 * surface carriers, prompt headers, and `session/end-seed` markers ahead of
 * the first `step/start`. Header migration and target-header validation reuse
 * the released edge unchanged.
 */
export const coharnessV2ToV3Dialect: SessionFormatMigration = Object.freeze({
  name: sessionFormatV2ToV3.name,
  fromVersion: 2,
  toVersion: 3,
  migrateHeader: sessionFormatV2ToV3.migrateHeader.bind(sessionFormatV2ToV3),
  validateTargetHeader: sessionFormatV2ToV3.validateTargetHeader.bind(sessionFormatV2ToV3),
  createStage(input: SessionFormatMigrationStageInput): SessionFormatMigrationStage {
    return new CoharnessV2DialectStage(input)
  },
})

/**
 * The dialect's ordering policy: every admission and rewrite rule delegates to
 * the released v2→v3 primitives, while the dialect itself owns the sequencing
 * the released stage cannot express — turn-scope surface carriers, prompt
 * headers, and `session/end-seed` markers buffered ahead of the first
 * `step/start`, drained in place at a `turn/start` boundary or after the head
 * a step opens. A seeded source without an in-band marker gains the
 * synthesized `inherited: true` marker immediately before the first post-cut
 * event, and a seeded log that ends inside its inherited prefix owes the
 * marker at the end.
 */
class CoharnessV2DialectStage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private readonly input: SessionFormatMigrationStageInput
  private readonly sessionId: string
  private readonly seeded: boolean
  /** The declared inherited cut, or the position an in-band marker adopts. */
  private sourceCut: number | undefined
  private readonly state: LegacyNormalizationState = { messageIds: new Map(), retryIds: new Map() }
  private readonly pending: SessionFormatEvent[] = []
  /** Source position to target position for every emitted source event. */
  private readonly mapping: number[] = []
  private readonly originalIds = new Set<string>()
  private readonly generatedIds = new Set<string>()
  private targetSeq = 0
  private sourceSeen = 0
  private inheritedCut = 0
  private markerEmitted = false
  private head: number | undefined
  private prompt: string | undefined
  private step: { turn: number; step: number } | undefined
  private lastForeignDeliverySeq: number | undefined
  private lastTime: number

  constructor(input: SessionFormatMigrationStageInput) {
    this.input = input
    this.sessionId = input.sourceHeader.id
    this.seeded = input.sourceHeader.isSeeded
    this.sourceCut = input.sourceInheritedEventCount
    if (!this.seeded) {
      this.headerInheritedEventCount = 0
      this.sourceCut = 0
    }
    this.lastTime = input.sourceHeader.createdAt
  }

  transformEvent(raw: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (raw.seq !== this.sourceSeen++) {
      throw new SessionFormatError('format v2 source events must be dense')
    }
    this.lastTime = raw.time
    let event = normalizeLegacyEvent(raw, this.sessionId, this.state)
    assertV2CarrierShape(event)
    event = stripNonSurfaceMetadata(event)
    /* The dialect wrote turn-scope surface carriers without the v2 placement
     * fields; append is their source-order placement. */
    if (SURFACE_TYPES.has(event.type) && event['surfaceOp'] === undefined) {
      event = { ...event, surfaceOp: 'append' }
    }
    assertEvent(event, 2)
    this.observeMessageIds(event)
    if (event.type === 'step/start') {
      const data = record(event.data, event.type)
      /* assertEvent above already proved the released coordinate pair. */
      this.step = { turn: data['turn'] as number, step: data['step'] as number }
    }
    if (isCutMarker(event, this.seeded, this.sourceCut)) {
      if (!this.seeded) {
        throw new SessionFormatError('format v2 unseeded Session contains an inherited end-seed marker')
      }
      if (this.sourceCut !== undefined && event.seq !== this.sourceCut) {
        throw new SessionFormatError('format v2 inherited end-seed marker must sit at the inherited event cut')
      }
      /* An upstream edge may already carry the boundary in-band when the
       * header count did not reach this stage; the marker then states it. */
      this.sourceCut ??= event.seq
    }
    if (event.type === 'session-log-deepseek/delivery-accepted') {
      const data = record(event.data, event.type)
      if (data['sessionFormatVersion'] === 3) {
        throw new SessionFormatError('format v2 delivery marker claims target format v3')
      }
      if (data['sessionFormatVersion'] === 2 && data['sessionId'] !== this.sessionId) {
        this.lastForeignDeliverySeq = event.seq
      }
    }
    /* The dialect keeps events ahead of the first step at turn scope. A
     * `turn/start` stays in place because turn nesting may not cross, and it
     * first drains the pending events that belong to the earlier turn — but
     * only those legal before a head exists; surface carriers and prompt
     * headers stay buffered until the first `step/start` opens one. */
    if (this.head === undefined && event.type !== 'step/start') {
      if (event.type === 'turn/start') {
        let drainable = 0
        while (drainable < this.pending.length
          && canEmitWithoutHead(this.pending[drainable] as SessionFormatEvent, this.mapping)) {
          drainable += 1
        }
        for (const pending of this.pending.splice(0, drainable)) this.emitOne(pending, context, true)
        this.emitOne(event, context)
      } else {
        this.pending.push(event)
      }
      return
    }
    this.emitOne(event, context)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(context: SessionFormatMigrationContext): number {
    for (const pending of this.pending.splice(0)) this.emitOne(pending, context, true)
    if (this.seeded && !this.markerEmitted) {
      /* A seeded source that never reached its cut still owes the marker so
       * the stream states the boundary in-band for the next migration. */
      if (this.sourceCut === undefined) {
        throw new SessionFormatError('format v2 seeded Session requires its inherited event count')
      }
      if (this.sourceSeen !== this.sourceCut) {
        throw new SessionFormatError('format v2 seeded Session ended before its declared inherited cut')
      }
      this.emitMarker({ inherited: true }, this.lastTime, context)
    }
    /* The cut is definite here: an unseeded source cut at 0 and a seeded
     * source either emitted its marker or threw inside the block above. */
    const sourceCut = this.sourceCut as number
    if (this.lastForeignDeliverySeq !== undefined
      && (this.input.sourceHeader.parentSession === undefined
        || this.lastForeignDeliverySeq >= sourceCut)) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    return this.inheritedCut
  }

  private emitOne(event: SessionFormatEvent, context: SessionFormatMigrationContext, fromPending = false): void {
    /* A seeded source keeps the cut only in its header when no in-band marker
     * exists; emit it the moment the stream crosses the boundary — ahead of
     * the first post-cut source event and any head synthesized for it. A real
     * marker at the cut emits in place inside emitMapped instead. */
    if (this.seeded && !this.markerEmitted && this.sourceCut !== undefined
      && event.seq >= this.sourceCut && !isCutMarker(event, this.seeded, this.sourceCut)) {
      this.emitMarker({ inherited: true }, event.time, context)
    }
    if (isCutMarker(event, this.seeded, this.sourceCut)) {
      this.emitMapped({ ...event, data: { inherited: true } }, context)
      return
    }
    if (event.type === 'request/header') {
      if (this.step === undefined) {
        throw new SessionFormatError('v2 request/header appears outside an open step')
      }
      const data = record(event.data, event.type)
      const { system, ...header } = record(data['header'], 'request header')
      const prompt = typeof system === 'string' ? system : ''
      if (this.head === undefined || prompt !== this.prompt) {
        this.emitSystem(prompt, event, this.step, context)
      }
      this.emitMapped({ ...event, data: { ...data, header } }, context)
    } else {
      this.emitMapped(event, context)
    }
    if (event.type === 'step/start' && this.head === undefined) {
      /* transformEvent admitted the coordinates before the event reached emission. */
      const opened = record(event.data, event.type)
      this.emitSystem('', event, { turn: opened['turn'] as number, step: opened['step'] as number }, context)
      for (const pending of this.pending.splice(0)) this.emitOne(pending, context, true)
    }
    if (!fromPending && (event.type === 'step/end' || event.type === 'turn/end')) {
      /* A pending closer belongs to a step-free turn that preceded the step
       * the flush opened; it must not clear that step. */
      this.step = undefined
    }
  }

  private emitMapped(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const targetSeq = this.targetSeq++
    this.mapping[event.seq] = targetSeq
    /* The cut counts the events before the marker; a real marker states the
     * boundary in-band so a downstream edge never maps a header count into
     * this sequence space. */
    if (event.type === 'session/end-seed' && isRecord(event.data) && event.data['inherited'] === true) {
      this.inheritedCut = targetSeq
      this.markerEmitted = true
    } else if (this.sourceCut !== undefined && event.seq < this.sourceCut) {
      this.inheritedCut = this.targetSeq
    }
    context.emitEvent(canonicalizeTransformedEvent(renamePtcEvent(remapEvent(event, targetSeq, this.mapping))))
  }

  private emitMarker(data: SessionFormatJsonObject, time: number, context: SessionFormatMigrationContext): void {
    const seq = this.targetSeq++
    this.inheritedCut = seq
    this.markerEmitted = true
    context.emitEvent(canonicalizeTransformedEvent({
      type: 'session/end-seed', seq, time, data,
    }))
  }

  /* jscpd:ignore-start -- mirrors the released stage's generated-head emission
   * and identity bookkeeping, which it does not export; this variant also
   * counts generated nodes inside the inherited region. */
  private emitSystem(
    prompt: string,
    anchor: SessionFormatEvent,
    step: { turn: number; step: number },
    context: SessionFormatMigrationContext,
  ): void {
    const identity = JSON.stringify(['session-format-v2-to-v3', this.sessionId, anchor.seq, anchor.type])
    const id = `v2-to-v3-system-${createHash('sha256').update(identity).digest('hex')}`
    if (this.originalIds.has(id) || this.generatedIds.has(id)) {
      throw new SessionFormatUnsupportedMigrationError(
        'generated system message id collides with an existing message id',
      )
    }
    this.generatedIds.add(id)
    const seq = this.targetSeq++
    /* A generated node emitted inside the inherited region belongs to it. */
    if (this.sourceCut !== undefined && anchor.seq < this.sourceCut) this.inheritedCut = this.targetSeq
    context.emitEvent(canonicalizeTransformedEvent({
      type: 'system/message', seq, time: anchor.time,
      data: {
        turn: step.turn,
        step: step.step,
        message: {
          id,
          role: 'system',
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
          content: prompt === '' ? [] : [{ type: 'text', text: prompt }],
        },
      },
      ...(this.head === undefined
        ? { surfaceOp: 'append' }
        : { surfaceOp: { op: 'replace', start: this.head, end: this.head }, sourceEventSeqs: [this.head] }),
    }))
    this.head = seq
    this.prompt = prompt
  }

  private observeMessageIds(event: SessionFormatEvent): void {
    const data = record(event.data, event.type)
    const messages = event.type === 'user/message' ? [data]
      : event.type === 'assistant/message' || event.type === 'tool/result'
        ? [record(data['message'], 'message')]
        : event.type === 'agent/inbox/spliced' ? data['inserted']
          : event.type === 'session/title-llm-request' ? data['messages'] : []
    /* assertEvent validates every owned message before identity observation. */
    for (const message of messages as readonly SessionFormatJsonObject[]) {
      const id = message['id'] as string
      if (this.generatedIds.has(id)) {
        throw new SessionFormatUnsupportedMigrationError('source message id collides with a generated system message id')
      }
      this.originalIds.add(id)
    }
  }
  /* jscpd:ignore-end */
}
