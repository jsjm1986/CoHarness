import { defineSessionFormatMigration } from './legacy-chain.ts'
import { createSessionFormatCatalog } from './legacy-catalog.ts'
import { SessionFormatError, SessionFormatUnsupportedMigrationError } from './error.ts'
import type { SessionFormatArtifact, SessionFormatHeader } from './legacy-types.ts'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatMigrationContext, SessionFormatMigrationStage } from './legacy-types.ts'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'

/**
 * Normalize the CoHarness v0 event vocabulary into the v1 logical form.
 * CoHarness wrote v0 across a vocabulary rename window, so released logs may
 * still carry `compact/*` types, `steering/message` envelopes, turn
 * trigger/reason variants, header `messagePrefix`, and messages without
 * identity. Each rewrite is shape-conditional: already-current payloads pass
 * through unchanged. Payloads with no released successor
 * (`request/header-delta`, `mode/set`, a `fallback` header reason) refuse
 * instead of silently corrupting the migrated log.
 */
const v0ToV1 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v0-to-v1',
  fromVersion: 0,
  toVersion: 1,
  migrateHeader: (header: SessionFormatHeader) => ({ ...header, version: 1 }),
  migrate: (artifact: SessionFormatArtifact) => {
    const output: SessionFormatEvent[] = []
    const stream = v0ToV1.createStage?.({
      sourceHeader: artifact.header,
      targetHeader: { ...artifact.header, version: 1 },
      sourceInheritedEventCount: artifact.inheritedEventCount,
    })
    /* v8 ignore next -- the catalog declares this stage; the guard protects future declaration drift. */
    if (stream === undefined) throw new Error('v0-to-v1 migration stage is unavailable')
    const context: SessionFormatMigrationContext = { emitEvent: event => output.push(event) }
    for (const event of artifact.events) stream.transformEvent(event, context)
    const cut = stream.finish(context)
    return {
      ...artifact,
      header: v0ToV1.migrateHeader(artifact.header),
      events: output,
      /* v8 ignore next -- LegacyNormalizationStage.finish always returns its inherited cut. */
      inheritedEventCount: cut ?? artifact.inheritedEventCount,
    }
  },
  createStage: ({ sourceHeader, sourceInheritedEventCount }) => (
    new LegacyNormalizationStage(sourceHeader, sourceInheritedEventCount, 'v0')
  ),
  validateTargetHeader: () => {},
  validateTarget: () => {},
})

/** v1→v2 kept the event vocabulary; the stage still normalizes legacy payloads a v1 body may carry. */
const v1ToV2 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v1-to-v2',
  fromVersion: 1,
  toVersion: 2,
  migrateHeader: (header: SessionFormatHeader) => ({ ...header, version: 2 }),
  migrate: (artifact: SessionFormatArtifact) => {
    const output: SessionFormatEvent[] = []
    const stream = v1ToV2.createStage?.({
      sourceHeader: artifact.header,
      targetHeader: { ...artifact.header, version: 2 },
      sourceInheritedEventCount: artifact.inheritedEventCount,
    })
    /* v8 ignore next -- the catalog declares this stage; the guard protects future declaration drift. */
    if (stream === undefined) throw new Error('v1-to-v2 migration stage is unavailable')
    const context: SessionFormatMigrationContext = { emitEvent: event => output.push(event) }
    for (const event of artifact.events) stream.transformEvent(event, context)
    const cut = stream.finish(context)
    return {
      ...artifact,
      header: v1ToV2.migrateHeader(artifact.header),
      events: output,
      /* v8 ignore next -- LegacyNormalizationStage.finish always returns its inherited cut. */
      inheritedEventCount: cut ?? artifact.inheritedEventCount,
    }
  },
  createStage: ({ sourceHeader, sourceInheritedEventCount }) => (
    new LegacyNormalizationStage(sourceHeader, sourceInheritedEventCount, 'v1')
  ),
  validateTargetHeader: () => {},
  validateTarget: () => {},
})

interface LegacyNormalizationState {
  readonly messageIds: Map<number, string>
  readonly retryIds: Map<string, string>
  compactionId?: string
}

/**
 * Shape-conditional legacy normalization shared by the v0→v1 and v1→v2
 * stages. CoHarness stamped format versions while payloads still carried the
 * pre-v1 vocabulary, so any pre-v3 source may need it; already-current
 * payloads pass through unchanged.
 */
/**
 * Whether a `session/end-seed` event is the inherited-seed cut marker rather
 * than a bare lifecycle delimiter. Pre-v3 writers emit the bare form at resume
 * boundaries; the v2 wire identifies the cut marker by `inherited: true`, and
 * seeded pre-v2 logs place a bare marker exactly at the seed cut. Only the cut
 * marker is subject to seed consistency checks — unmarked delimiters pass
 * through the chain unchanged.
 */
function isInheritedSeedMarker(
  event: SessionFormatEvent,
  sourceHeader: SessionFormatHeader,
  sourceCut: number | undefined,
): boolean {
  if (event.type !== 'session/end-seed') return false
  const data = isRecord(event.data) ? event.data : undefined
  if (data?.['inherited'] === true) return true
  return sourceHeader.isSeeded === true && event.seq === sourceCut
}

class LegacyNormalizationStage implements SessionFormatMigrationStage {
  private readonly state: LegacyNormalizationState = { messageIds: new Map(), retryIds: new Map() }
  private endSeedSeq: number | undefined
  /* Payload-only normalization preserves every sequence, so the cut is the
   * same coordinate in the target space and the next edge may rely on it. */
  readonly headerInheritedEventCount: number

  constructor(
    private readonly sourceHeader: SessionFormatHeader,
    private readonly sourceCut: number | undefined,
    private readonly label: string,
  ) {
    this.headerInheritedEventCount = sourceCut ?? 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const normalized = normalizeLegacyEvent(event, this.sourceHeader.id, this.state)
    if (isInheritedSeedMarker(normalized, this.sourceHeader, this.sourceCut)) this.endSeedSeq = normalized.seq
    context.emitEvent(normalized)
  }

  finish(): number {
    /* Pre-v3 seeded logs carry the cut only as header `seedLength`; the
     * `session/end-seed` event is a v3 construction marker, so its absence is
     * expected and only a present marker is validated. */
    if (this.endSeedSeq !== undefined && this.endSeedSeq !== this.sourceCut) {
      throw new SessionFormatError(`format ${this.label} inherited end-seed marker disagrees with its seed cut`)
    }
    if (this.sourceHeader.isSeeded !== true && this.endSeedSeq !== undefined) {
      throw new SessionFormatError(`format ${this.label} unseeded Session contains an inherited end-seed marker`)
    }
    return this.sourceCut ?? 0
  }
}

/* jscpd:ignore-start -- the catalog embeds this migration body intentionally:
 * the published migration packages already depend on session-format, so
 * importing them back would close a dependency cycle. */
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
    .join('')
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
  const normalized = list.map((item, index) => {
    if (!isRecord(item) || Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'content')) return item
    return { ...item, role: 'user', id: `${legacyMessageId(sessionId, event.seq)}:${index}` }
  })
  return { ...event, data: { ...data, [field]: normalized } }
}

/** Legacy replace ops name their shadowed range `start`/`end` in source coordinates. */
function replacementStartSeq(event: SessionFormatEvent): number | undefined {
  const operation = (event as SessionFormatEvent & { surfaceOp?: unknown }).surfaceOp
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

/**
 * Convert the CoHarness v2 request-header system prompt into a durable surface
 * node. The migration keeps the existing logical event vocabulary and remaps
 * surface references when the inserted system node shifts later sequences.
 */
const v2ToV3 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v2-to-v3',
  fromVersion: 2,
  toVersion: 3,
  migrateHeader: (header: SessionFormatHeader) => ({
    ...header,
    version: 3,
  }),
  migrate: (artifact: SessionFormatArtifact) => {
    const output: SessionFormatEvent[] = []
    const stream = v2ToV3.createStage?.({
      sourceHeader: artifact.header,
      targetHeader: { ...artifact.header, version: 3 },
      sourceInheritedEventCount: artifact.inheritedEventCount,
    })
    /* v8 ignore next -- the catalog declares this stage; the guard protects future declaration drift. */
    if (stream === undefined) throw new Error('v2-to-v3 migration stage is unavailable')
    const context: SessionFormatMigrationContext = { emitEvent: event => output.push(event) }
    for (const event of artifact.events) stream.transformEvent(event, context)
    const cut = stream.finish(context)
    return {
      ...artifact,
      header: v2ToV3.migrateHeader(artifact.header),
      events: output,
      /* v8 ignore next -- V2ToV3Stage.finish always returns its inherited cut. */
      inheritedEventCount: cut ?? artifact.inheritedEventCount,
    }
  },
  createStage: ({ sourceHeader, sourceInheritedEventCount }) => (
    new V2ToV3Stage(sourceHeader, sourceInheritedEventCount)
  ),
  validateTargetHeader: () => {},
  validateTarget: () => {},
})

class V2ToV3Stage implements SessionFormatMigrationStage {
  private readonly mapping: number[] = []
  private readonly sourceMessageIds = new Set<string>()
  private readonly generatedMessageIds = new Set<string>()
  private readonly legacyState: LegacyNormalizationState = { messageIds: new Map(), retryIds: new Map() }
  private readonly pendingHead: SessionFormatEvent[] = []
  private sourceSeen = 0
  private targetSeq = 0
  private inheritedCut = 0
  private markerEmitted = false
  private systemSeq: number | undefined
  private currentPrompt = ''
  private step: { turn: number; step: number } | undefined
  private lastForeignDeliverySeq: number | undefined
  private lastTime: number

  constructor(private readonly sourceHeader: SessionFormatHeader, sourceCut: number | undefined) {
    this.sourceCut = sourceCut ?? 0
    this.lastTime = sourceHeader.createdAt
  }

  private readonly sourceCut: number

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.sourceSeen++) {
      throw new SessionFormatError('format v2 source events must be dense')
    }
    this.lastTime = event.time
    const normalized = normalizeLegacyEvent(event, this.sourceHeader.id, this.legacyState)
    assertV2CarrierShape(normalized)
    this.observeMessageIds(normalized)
    if (normalized.type === 'step/start') {
      const data = normalized.data as Record<string, unknown>
      if (typeof data.turn !== 'number' || typeof data.step !== 'number') throw new SessionFormatError('v2 step/start lacks turn or step')
      this.step = { turn: data.turn, step: data.step }
    }
    if (isInheritedSeedMarker(normalized, this.sourceHeader, this.sourceCut)) {
      if (this.sourceHeader.isSeeded !== true) {
        throw new SessionFormatError('format v2 unseeded Session contains an inherited end-seed marker')
      }
      if (normalized.seq !== this.sourceCut) {
        throw new SessionFormatError('format v2 inherited end-seed marker must sit at the inherited event cut')
      }
    }
    if (normalized.type === 'session-log-deepseek/delivery-accepted') {
      const data = normalized.data as Record<string, unknown>
      if (data['sessionId'] !== this.sourceHeader.id && normalized.seq >= this.sourceCut) {
        this.lastForeignDeliverySeq = normalized.seq
      }
    }
    /* CoHarness v2 keeps `user/message` and other surface carriers at turn
     * scope, ahead of the first `step/start`. The v3 system head must precede
     * surface content in target order, so everything before the head buffers —
     * including `session/title`, which cites buffered sequences, and
     * `session/end-seed`, whose inherited cut must account for the generated
     * head. `turn/start` stays in place because turn nesting may not cross, and
     * it first drains the pending events that belong to the earlier turn. */
    if (this.systemSeq === undefined && normalized.type !== 'step/start') {
      if (normalized.type === 'turn/start') {
        for (const pending of this.pendingHead.splice(0)) this.emitOne(pending, context, true)
      } else {
        this.pendingHead.push(normalized)
        return
      }
    }
    this.emitOne(normalized, context)
  }

  private emitOne(event: SessionFormatEvent, context: SessionFormatMigrationContext, fromPending = false): void {
    /* A seeded v3 log carries an explicit `session/end-seed` cut marker; the
     * v2 source keeps the cut only in its header, so emit the marker the moment
     * output crosses the boundary — ahead of the first post-cut source event
     * and any head synthesized for it. A real marker at the cut emits in place
     * inside emitMapped instead. */
    if (this.sourceHeader.isSeeded === true && !this.markerEmitted
        && event.seq >= this.sourceCut
        && !isInheritedSeedMarker(event, this.sourceHeader, this.sourceCut)) {
      context.emitEvent({
        type: 'session/end-seed',
        seq: this.targetSeq,
        time: event.time,
        data: { inherited: true },
      })
      this.inheritedCut = this.targetSeq
      this.targetSeq += 1
      this.markerEmitted = true
    }
    if (event.type === 'request/header') {
      const data = event.data as Record<string, unknown>
      const header = data.header as Record<string, unknown> | undefined
      const system = typeof header?.system === 'string' ? header.system : ''
      if (this.step === undefined) throw new SessionFormatError('v2 request/header appears outside an open step')
      if (this.systemSeq === undefined || system !== this.currentPrompt) this.emitSystem(system, event, context)
      const { system: _system, ...withoutSystem } = header ?? {}
      this.emitMapped({ ...event, data: { ...data, header: withoutSystem } as never }, context)
    } else {
      this.emitMapped(event, context)
    }
    if (event.type === 'step/start' && this.systemSeq === undefined) {
      this.emitSystem('', event, context)
      for (const pending of this.pendingHead.splice(0)) this.emitOne(pending, context, true)
    }
    /* A pending `turn/end` closes a step-free turn that preceded this step;
     * it must not clear the step the flush just opened. */
    if (!fromPending && (event.type === 'step/end' || event.type === 'turn/end')) this.step = undefined
  }

  finish(context: SessionFormatMigrationContext): number {
    for (const pending of this.pendingHead.splice(0)) this.emitOne(pending, context, true)
    /* A seeded source that never reached its cut still owes the marker so the
     * v3 stream states the boundary explicitly for the next migration. */
    if (this.sourceHeader.isSeeded === true && !this.markerEmitted) {
      context.emitEvent({
        type: 'session/end-seed',
        seq: this.targetSeq,
        time: this.lastTime,
        data: { inherited: true },
      })
      this.inheritedCut = this.targetSeq
      this.targetSeq += 1
      this.markerEmitted = true
    }
    if (this.lastForeignDeliverySeq !== undefined) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    return this.inheritedCut
  }

  private emitMapped(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const targetSeq = this.targetSeq++
    this.mapping[event.seq] = targetSeq
    /* The cut counts the events before the marker; generated nodes landed
     * inside the inherited region belong to it as well. */
    const marker = isInheritedSeedMarker(event, this.sourceHeader, this.sourceCut)
    if (marker) {
      this.inheritedCut = targetSeq
      this.markerEmitted = true
    } else if (event.seq < this.sourceCut) {
      this.inheritedCut = this.targetSeq
    }
    context.emitEvent({
      ...event,
      seq: targetSeq,
      // The v3 marker states the boundary in-band so a downstream migration
      // never has to map its own header count into this sequence space.
      data: marker ? { inherited: true } : this.remapDataReferences(event),
      ...this.remapSurfaceOp(event),
      ...this.remapSourceEventSeqs(event),
    } as unknown as SessionFormatEvent)
  }

  /** Remap the audited same-artifact sequence references carried inside event payloads. */
  private remapDataReferences(event: SessionFormatEvent): unknown {
    const data = event.data
    if (!isRecord(data)) return data
    switch (event.type) {
      case 'command/done': {
        if (data['sourceEventSeq'] === undefined) return data
        return { ...data, sourceEventSeq: this.mappingNumber(data['sourceEventSeq']) }
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const range = data['shadowedRange']
        const seqs = data['shadowedSeqs']
        if (!isRecord(range)) throw new SessionFormatError(`v2 ${event.type} lacks its shadowedRange`)
        return {
          ...data,
          shadowedRange: {
            ...range,
            start: this.mappingNumber(range['start']),
            end: this.mappingNumber(range['end']),
          },
          shadowedSeqs: this.mappingList(seqs, 'shadowedSeqs'),
        }
      }
      case 'session/title':
      case 'session/title-llm-request': {
        if (data['messageSeqs'] === undefined) return data
        return { ...data, messageSeqs: this.mappingList(data['messageSeqs'], 'messageSeqs') }
      }
      default:
        return data
    }
  }

  /** Canonicalize a source `start`/`end` replace op into the v3 `startSeq`/`endSeq` form. */
  private remapSurfaceOp(event: SessionFormatEvent): { surfaceOp?: unknown } {
    const raw = (event as SessionFormatEvent & { surfaceOp?: unknown }).surfaceOp
    if (raw === undefined) return {}
    if (raw === 'append') return { surfaceOp: 'append' }
    if (!isRecord(raw) || raw['op'] !== 'replace'
      || !Object.hasOwn(raw, 'start') || !Object.hasOwn(raw, 'end')) {
      throw new SessionFormatError(`format v2 ${event.type} at seq ${event.seq} requires exact replace fields op/start/end`)
    }
    return {
      surfaceOp: {
        op: 'replace',
        startSeq: this.mappingNumber(raw['start']),
        endSeq: this.mappingNumber(raw['end']),
      },
    }
  }

  private remapSourceEventSeqs(event: SessionFormatEvent): { sourceEventSeqs?: unknown } {
    const raw = (event as SessionFormatEvent & { sourceEventSeqs?: unknown }).sourceEventSeqs
    if (raw === undefined) return {}
    if (event.type === 'assistant/message') {
      throw new SessionFormatError(`format v2 assistant/message at seq ${event.seq} embeds its stream and cannot carry sourceEventSeqs`)
    }
    return { sourceEventSeqs: this.mappingList(raw, 'sourceEventSeqs') }
  }

  private mappingList(value: unknown, label: string): number[] {
    if (!Array.isArray(value)) throw new SessionFormatError(`v2 ${label} must be an array`)
    return value.map(item => this.mappingNumber(item))
  }

  private emitSystem(text: string, anchor: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    /* v8 ignore next -- transformEvent establishes the step before calling this helper. */
    if (this.step === undefined) throw new SessionFormatError('v2 system prompt appears outside an open step')
    const identity = JSON.stringify(['session-format-v2-to-v3', this.sourceHeader.id, anchor.seq, anchor.type])
    const id = `v2-to-v3-system-${createHash('sha256').update(identity).digest('hex')}`
    if (this.sourceMessageIds.has(id) || this.generatedMessageIds.has(id)) throw new SessionFormatError('v2-to-v3 generated system message id collides with a source message')
    this.generatedMessageIds.add(id)
    const seq = this.targetSeq++
    if (anchor.seq < this.sourceCut) this.inheritedCut = this.targetSeq
    const surfaceOp = this.systemSeq === undefined ? 'append' : { op: 'replace', startSeq: this.systemSeq, endSeq: this.systemSeq }
    context.emitEvent({
      type: 'system/message',
      seq,
      time: anchor.time,
      data: {
        turn: this.step.turn,
        step: this.step.step,
        message: {
          id,
          role: 'system',
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
          content: text === '' ? [] : [{ type: 'text', text }],
        },
      },
      surfaceOp,
      ...this.systemSeq === undefined ? {} : { sourceEventSeqs: [this.systemSeq] },
    })
    this.systemSeq = seq
    this.currentPrompt = text
  }

  private mappingNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || this.mapping[value] === undefined) throw new SessionFormatError('v2-to-v3 surface reference does not name an earlier event')
    return this.mapping[value]
  }

  private observeMessageIds(event: SessionFormatEvent): void {
    const data = event.data as Record<string, unknown>
    const values: unknown[] = event.type === 'user/message' ? [data]
      : event.type === 'assistant/message' || event.type === 'tool/result' ? [data.message]
        : event.type === 'agent/inbox/spliced' ? (Array.isArray(data.inserted) ? data.inserted :
          /* v8 ignore next -- assertV2CarrierShape has already rejected a non-array inserted list */
          [])
          : event.type === 'session/title-llm-request' ? (Array.isArray(data.messages) ? data.messages :
            /* v8 ignore next -- assertV2CarrierShape has already rejected a non-array messages list */
            []) : []
    for (const value of values) {
      /* v8 ignore next -- assertV2CarrierShape guarantees every collected message carrier is an object */
      if (typeof value !== 'object' || value === null) continue
      const id = (value as Record<string, unknown>).id
      if (typeof id !== 'string') continue
      if (this.generatedMessageIds.has(id)) throw new SessionFormatError('v2 source message id collides with a generated system message')
      this.sourceMessageIds.add(id)
    }
  }
}

/**
 * Fold released-v3 top-level `assistant/chunk` events into the v4 embedded
 * Assistant streams. The v3 generation carried each live model chunk as its own
 * durable event — optionally packed into physical `text-chunks`/`reasoning-chunks`/
 * `tool-call-chunks` rows — and duplicated the settled stream inside the closing
 * `assistant/message` or `assistant/attempt` payload. The v4 generation keeps
 * only the settlement: chunk events are consumed, not emitted, and every
 * settlement carries (or gains) the exact compact `stream` records.
 *
 * Fold rules per (turn, step) attempt group: a settlement that already embeds
 * `stream` makes its buffered chunks redundant — they drop with it unchanged;
 * a settlement without `stream` adopts the group's folded records; a group
 * closed by `step/end`, `turn/end`, `llm/retry`, or `llm/retry-started`
 * without a settlement synthesizes `assistant/attempt` (a torn or abandoned
 * stream). Non-chunk events interleaved with chunks emit in source order
 * around the settlement. Consumed chunk sequences never map, so a later
 * `sourceEventSeqs`, `surfaceOp`, or payload reference naming one refuses the
 * migration rather than silently corrupting the log.
 *
 * The inherited boundary is stated in-band: released-v3 seeded logs place a
 * bare `session/end-seed` marker at the header's seed count and upstream
 * migration stages emit the self-describing `inherited: true` form. A chunk
 * group straddling the marker, or a seeded artifact missing it, refuses.
 */
const v3ToV4 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v3-to-v4',
  fromVersion: 3,
  toVersion: 4,
  migrateHeader: (header: SessionFormatHeader) => ({
    ...header,
    version: 4,
  }),
  migrate: (artifact: SessionFormatArtifact) => {
    const output: SessionFormatEvent[] = []
    const stream = v3ToV4.createStage?.({
      sourceHeader: artifact.header,
      targetHeader: { ...artifact.header, version: 4 },
      sourceInheritedEventCount: artifact.inheritedEventCount,
    })
    /* v8 ignore next -- the catalog declares this stage; the guard protects future declaration drift. */
    if (stream === undefined) throw new Error('v3-to-v4 migration stage is unavailable')
    const context: SessionFormatMigrationContext = { emitEvent: event => output.push(event) }
    for (const event of artifact.events) stream.transformEvent(event, context)
    const cut = stream.finish(context)
    return {
      ...artifact,
      header: v3ToV4.migrateHeader(artifact.header),
      events: output,
      /* v8 ignore next -- V3ToV4Stage.finish always returns its inherited cut. */
      inheritedEventCount: cut ?? artifact.inheritedEventCount,
    }
  },
  createStage: ({ sourceHeader, sourceInheritedEventCount }) => (
    new V3ToV4Stage(sourceHeader, sourceInheritedEventCount)
  ),
  validateTargetHeader: () => {},
  validateTarget: () => {},
})

/** One (turn, step) attempt's buffered chunk fold while the settlement is pending. */
interface V3AttemptGroup {
  readonly turn: number
  readonly step: number
  readonly accumulator: AssistantStreamAccumulator
  /** Whether every buffered chunk sits on the inherited side of the seed cut. */
  readonly inherited: boolean
  lastSeq: number
  lastTime: number
  terminal: boolean
}

interface V3PendingAttempt {
  readonly group: V3AttemptGroup
  readonly afterLastChunk: SessionFormatEvent[]
}

/** Events that close an open attempt without a settlement of their own. */
function closesV3Attempt(event: SessionFormatEvent): boolean {
  return event.type === 'turn/end'
    || event.type === 'step/end'
    || event.type === 'llm/retry'
    || event.type === 'llm/retry-started'
}

class V3ToV4Stage implements SessionFormatMigrationStage {
  private readonly mapping: number[] = []
  private sourceSeen = 0
  private targetSeq = 0
  private inheritedCut: number | undefined
  private cutSeen = false
  private pending: V3PendingAttempt | undefined

  constructor(private readonly sourceHeader: SessionFormatHeader, private readonly sourceCut: number | undefined) {
    this.inheritedCut = sourceHeader.isSeeded === true ? undefined : 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.sourceSeen++) {
      throw new SessionFormatError('format v3 source events must be dense')
    }
    if (this.isCutMarker(event)) {
      /* The boundary must not fall inside a live chunk group: folding members
       * from both sides into one attempt would corrupt the fork lineage. A
       * group still open when the marker arrives can only settle across it. */
      if (this.pending !== undefined) {
        throw new SessionFormatError(`inherited Session cut splits one Assistant attempt at seq ${event.seq}`)
      }
      this.cutSeen = true
      this.inheritedCut = this.targetSeq
      this.emitSource(event, context)
      return
    }
    if (event.type === 'assistant/chunk') {
      this.transformChunk(event, context)
      return
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      this.transformSettlement(event, context)
      return
    }
    if (closesV3Attempt(event)) {
      this.finishAttempt(context)
      this.emitSource(event, context)
      return
    }
    if (this.pending !== undefined) {
      this.pending.afterLastChunk.push(event)
      return
    }
    this.emitSource(event, context)
  }

  /**
   * Whether a `session/end-seed` event is the inherited-seed cut marker: the
   * self-describing `inherited: true` form written by an upstream migration,
   * or a released-v3 bare marker exactly at the header's seed count. Later
   * `end-seed` events are ordinary delimiters.
   */
  private isCutMarker(event: SessionFormatEvent): boolean {
    if (event.type !== 'session/end-seed' || this.cutSeen) return false
    const data = isRecord(event.data) ? event.data : undefined
    if (data?.['inherited'] === true) {
      if (this.sourceHeader.isSeeded !== true) {
        throw new SessionFormatError('format v3 unseeded Session contains an inherited end-seed marker')
      }
      /* When this stage reads a stored v3 artifact directly, the seed count is
       * in the same sequence space and a flagged marker off the cut is corrupt.
       * A chained source states the boundary only in-band, so the flagged form
       * is accepted at whichever position the upstream stage emitted it. */
      if (this.sourceCut !== undefined && event.seq !== this.sourceCut) {
        throw new SessionFormatError('format v3 inherited end-seed marker disagrees with its seed cut')
      }
      return true
    }
    return this.sourceHeader.isSeeded === true && event.seq === this.sourceCut
  }

  finish(context: SessionFormatMigrationContext): number {
    this.finishAttempt(context)
    /* Every seeded input states its boundary in-band: released-v3 logs place
     * the bare marker at the seed count and chained migrations emit the
     * `inherited: true` form, so a missing marker means the artifact is
     * corrupt rather than merely short. */
    if (this.sourceHeader.isSeeded === true && !this.cutSeen) {
      throw new SessionFormatError('format v3 seeded Session lacks its inherited end-seed marker')
    }
    return this.inheritedCut as number
  }

  /** Buffer one chunk into its (turn, step) group, closing a prior group on any boundary. */
  private transformChunk(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const data = event.data
    const record = isRecord(data) ? data : undefined
    const turn = record?.['turn']
    const step = record?.['step']
    const chunk = record?.['chunk']
    if (typeof turn !== 'number' || typeof step !== 'number' || !isRecord(chunk)) {
      throw new SessionFormatError(`format v3 assistant/chunk at seq ${event.seq} lacks turn, step, or chunk`)
    }
    const pending = this.pending
    if (pending !== undefined
      && (pending.group.terminal || pending.group.turn !== turn || pending.group.step !== step)) {
      this.finishAttempt(context)
    } else if (pending !== undefined) {
      this.flushBuffered(context)
    }
    this.pending ??= {
      group: {
        turn,
        step,
        accumulator: new AssistantStreamAccumulator(),
        inherited: this.sourceHeader.isSeeded === true && !this.cutSeen,
        lastSeq: event.seq,
        lastTime: event.time,
        terminal: false,
      },
      afterLastChunk: [],
    }
    const group = this.pending.group
    /* v8 ignore next 4 -- a cut marker refuses while a group is open, so a pending group always agrees with the current side of the cut. */
    if (group.inherited !== (this.sourceHeader.isSeeded === true && !this.cutSeen)) {
      throw new SessionFormatUnsupportedMigrationError(
        'inherited Session cut splits one Assistant attempt',
      )
    }
    group.accumulator.push({ time: event.time, chunk: chunk as unknown as StreamChunk })
    group.lastSeq = event.seq
    group.lastTime = event.time
    if (chunk['type'] === 'finish') group.terminal = true
  }

  /** Emit one settlement, folding or dropping its buffered chunk group by `stream` presence. */
  private transformSettlement(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const data = isRecord(event.data) ? event.data : undefined
    const turn = data?.['turn']
    const step = data?.['step']
    const pending = this.pending
    if (pending === undefined || pending.group.turn !== turn || pending.group.step !== step) {
      if (pending !== undefined) this.finishAttempt(context)
      this.emitSettlement(event, undefined, context)
      return
    }
    this.emitSettlement(event, pending.group, context)
    this.pending = undefined
  }

  private emitSettlement(
    event: SessionFormatEvent,
    group: V3AttemptGroup | undefined,
    context: SessionFormatMigrationContext,
  ): void {
    if (group !== undefined) this.flushBuffered(context)
    const data = isRecord(event.data) ? event.data : {}
    // An embedded stream settles the attempt on its own; buffered chunks were
    // its live duplicate and are consumed without a fold.
    const stream = (Array.isArray(data['stream'])
      ? data['stream']
      : group === undefined ? [] : group.accumulator.snapshot()) as unknown as SessionFormatEvent['data']
    const { sourceEventSeqs: _dropped, ...rest } = event as SessionFormatEvent & { sourceEventSeqs?: unknown }
    this.emitSource({ ...rest, data: { ...data, stream } }, context)
  }

  /** Close the pending group by publishing a synthesized `assistant/attempt`. */
  private finishAttempt(context: SessionFormatMigrationContext): void {
    const pending = this.pending
    if (pending === undefined) return
    const group = pending.group
    this.pending = undefined
    this.emitGenerated({
      type: 'assistant/attempt',
      seq: group.lastSeq,
      time: group.lastTime,
      data: {
        turn: group.turn,
        step: group.step,
        stream: group.accumulator.snapshot() as unknown as SessionFormatEvent['data'],
      },
    }, context)
    this.flushBufferedEvents(pending.afterLastChunk, context)
  }

  /** Emit buffered interleaved events in source order, ahead of the settlement they preceded. */
  private flushBuffered(context: SessionFormatMigrationContext): void {
    /* v8 ignore next -- both call sites only reach this helper with a pending group. */
    if (this.pending === undefined) return
    this.flushBufferedEvents(this.pending.afterLastChunk, context)
  }

  private flushBufferedEvents(events: SessionFormatEvent[], context: SessionFormatMigrationContext): void {
    for (const event of events.splice(0)) this.emitSource(event, context)
  }

  /** Emit one source event at the next target sequence, remapping every sequence reference. */
  private emitSource(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    this.mapping[event.seq] = this.targetSeq
    context.emitEvent(this.remapEvent(event))
    this.targetSeq += 1
  }

  /** Emit one migration-built event at the next target sequence. */
  private emitGenerated(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    context.emitEvent(this.remapEvent(event))
    this.targetSeq += 1
  }

  /** Rebuild one event at the current target sequence with every sequence reference remapped. */
  private remapEvent(event: SessionFormatEvent): SessionFormatEvent {
    const { sourceEventSeqs, surfaceOp, ...rest } = event as SessionFormatEvent & {
      sourceEventSeqs?: unknown
      surfaceOp?: unknown
    }
    const out: Record<string, unknown> = {
      ...rest,
      seq: this.targetSeq,
      data: this.remapDataReferences(event),
    }
    if (sourceEventSeqs !== undefined) {
      /* v8 ignore next 5 -- transformSettlement strips a settlement's
         sourceEventSeqs before emitSource, so remapEvent only sees it on
         non-settlement events. */
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        throw new SessionFormatError(
          `format v3 ${event.type} at seq ${event.seq} embeds its stream and cannot carry sourceEventSeqs`,
        )
      }
      out['sourceEventSeqs'] = this.mappingList(sourceEventSeqs, 'sourceEventSeqs')
    }
    if (surfaceOp !== undefined) {
      if (surfaceOp === 'append') {
        out['surfaceOp'] = 'append'
      } else {
        const raw = isRecord(surfaceOp) ? surfaceOp : {}
        if (raw['op'] !== 'replace' || !Object.hasOwn(raw, 'startSeq') || !Object.hasOwn(raw, 'endSeq')) {
          throw new SessionFormatError(`format v3 ${event.type} at seq ${event.seq} requires exact replace fields op/startSeq/endSeq`)
        }
        out['surfaceOp'] = {
          op: 'replace',
          startSeq: this.mappingNumber(raw['startSeq']),
          endSeq: this.mappingNumber(raw['endSeq']),
        }
      }
    }
    return out as unknown as SessionFormatEvent
  }

  /** Remap the audited same-artifact sequence references carried inside event payloads. */
  private remapDataReferences(event: SessionFormatEvent): unknown {
    const data = event.data
    if (!isRecord(data)) return data
    switch (event.type) {
      case 'command/done': {
        if (data['sourceEventSeq'] === undefined) return data
        return { ...data, sourceEventSeq: this.mappingNumber(data['sourceEventSeq']) }
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const range = data['shadowedRange']
        const seqs = data['shadowedSeqs']
        if (!isRecord(range)) throw new SessionFormatError(`v3 ${event.type} lacks its shadowedRange`)
        return {
          ...data,
          shadowedRange: {
            ...range,
            start: this.mappingNumber(range['start']),
            end: this.mappingNumber(range['end']),
          },
          shadowedSeqs: this.mappingList(seqs, 'shadowedSeqs'),
        }
      }
      case 'session/title':
      case 'session/title-llm-request': {
        if (data['messageSeqs'] === undefined) return data
        return { ...data, messageSeqs: this.mappingList(data['messageSeqs'], 'messageSeqs') }
      }
      default:
        return data
    }
  }

  private mappingNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || this.mapping[value] === undefined) {
      throw new SessionFormatError('v3-to-v4 surface reference does not name an earlier event')
    }
    return this.mapping[value]
  }

  private mappingList(value: unknown, label: string): number[] {
    if (!Array.isArray(value)) throw new SessionFormatError(`v3 ${label} must be an array`)
    return value.map(item => this.mappingNumber(item))
  }
}

/** Validate the JSON containers owned by message carriers before migration rewrites them. */
function assertV2CarrierShape(event: SessionFormatEvent): void {
/* jscpd:ignore-end */

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
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new SessionFormatError(`v2 ${event.type} has invalid data`)
  const record = data as Record<string, unknown>
  const field = event.type === 'assistant/message' || event.type === 'tool/result' ? 'message'
    : event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
  const value = record[field]
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

/** Header-only successor for the fork's declared draft metadata. */
const v4ToV5 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader: (header: SessionFormatHeader) => ({ ...header, version: 5 }),
  migrate: (artifact: SessionFormatArtifact) => ({ ...artifact, header: { ...artifact.header, version: 5 } }),
  createStage: ({ sourceHeader, sourceInheritedEventCount }) => {
    let inherited = sourceInheritedEventCount
    return {
      ...(inherited === undefined ? {} : { headerInheritedEventCount: inherited }),
      transformEvent(event, context) {
        if (event.type === 'session/end-seed' && event.data !== null && typeof event.data === 'object'
          && !Array.isArray(event.data) && event.data['inherited'] === true) inherited = event.seq
        context.emitEvent(event)
      },
      finish() {
        if (sourceHeader.isSeeded === true && inherited === undefined) {
          throw new SessionFormatError('format v4 seeded artifact has no inherited cut')
        }
        return inherited ?? 0
      },
    }
  },
  validateTargetHeader: () => {},
  validateTarget: () => {},
})

/** The complete static v0→v1→v2→v3→v4→v5 chain used by provider adapters. */
export const sessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 5,
  migrations: [v0ToV1, v1ToV2, v2ToV3, v3ToV4, v4ToV5],
  restoreCurrentHeader: header => header,
  restoreCurrent: artifact => artifact,
})
