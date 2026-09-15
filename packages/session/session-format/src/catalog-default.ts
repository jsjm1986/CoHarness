import { defineSessionFormatMigration } from './chain.ts'
import { createSessionFormatCatalog } from './catalog.ts'
import { SessionFormatError, SessionFormatUnsupportedMigrationError } from './error.ts'
import type { SessionFormatArtifact, SessionFormatHeader } from './types.ts'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatMigrationContext, SessionFormatMigrationStage } from './types.ts'
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
  sourceCut: number,
): boolean {
  if (event.type !== 'session/end-seed') return false
  const data = isRecord(event.data) ? event.data : undefined
  if (data?.['inherited'] === true) return true
  return sourceHeader.isSeeded === true && event.seq === sourceCut
}

class LegacyNormalizationStage implements SessionFormatMigrationStage {
  private readonly state: LegacyNormalizationState = { messageIds: new Map(), retryIds: new Map() }
  private endSeedSeq: number | undefined

  constructor(
    private readonly sourceHeader: SessionFormatHeader,
    private readonly sourceCut: number,
    private readonly label: string,
  ) {}

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
    return this.sourceCut
  }
}

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
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, 'provenance')) return event
      const { content, provenance, ...eventData } = data
      const source = isRecord(provenance) ? provenance : {}
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
  private systemSeq: number | undefined
  private currentPrompt = ''
  private step: { turn: number; step: number } | undefined
  private lastForeignDeliverySeq: number | undefined

  constructor(private readonly sourceHeader: SessionFormatHeader, private readonly sourceCut: number) {}

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.sourceSeen++) {
      throw new SessionFormatError('format v2 source events must be dense')
    }
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
    /* Pre-v3 seeded logs carry the cut only as header `seedLength`; the
     * `session/end-seed` event is a v3 construction marker, so its absence is
     * expected and only a present marker is validated in transformEvent. */
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
    if (isInheritedSeedMarker(event, this.sourceHeader, this.sourceCut)) this.inheritedCut = targetSeq
    else if (event.seq < this.sourceCut) this.inheritedCut = this.targetSeq
    context.emitEvent({
      ...event,
      seq: targetSeq,
      data: this.remapDataReferences(event),
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

/** The complete static v0→v1→v2→v3 chain used by provider adapters. */
export const sessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 3,
  migrations: [v0ToV1, v1ToV2, v2ToV3],
  restoreCurrentHeader: header => header,
  restoreCurrent: artifact => artifact,
})
