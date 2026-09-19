/** CoHarness v3→v4 migration: fold streamed assistant chunks into settled assistant events. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatHeader,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
    this.inheritedCut = sourceHeader.isSeeded ? undefined : 0
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

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
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
      if (!this.sourceHeader.isSeeded) {
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
    return this.sourceHeader.isSeeded && event.seq === this.sourceCut
  }

  finish(context: SessionFormatMigrationContext): number {
    this.finishAttempt(context)
    /* Every seeded input states its boundary in-band: released-v3 logs place
     * the bare marker at the seed count and chained migrations emit the
     * `inherited: true` form, so a missing marker means the artifact is
     * corrupt rather than merely short. */
    if (this.sourceHeader.isSeeded && !this.cutSeen) {
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
        inherited: this.sourceHeader.isSeeded && !this.cutSeen,
        lastSeq: event.seq,
        lastTime: event.time,
        terminal: false,
      },
      afterLastChunk: [],
    }
    const group = this.pending.group
    if (group.inherited !== (this.sourceHeader.isSeeded && !this.cutSeen)) {
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

/** CoHarness v4 migration declaration: folds v3 streamed chunks into settled assistant events. */
export const sessionFormatV3ToV4: SessionFormatMigration = Object.freeze({
  name: '@deepseek-ai/dsh-session-format-v3-to-v4',
  fromVersion: 3,
  toVersion: 4,
  migrateHeader: (header: SessionFormatHeader) => ({ ...header, version: 4 }),
  createStage(input: SessionFormatMigrationStageInput) {
    return new V3ToV4Stage(input.sourceHeader, input.sourceInheritedEventCount)
  },
  validateTargetHeader: (header: SessionFormatHeader) => {
    if (header.version !== 4) throw new SessionFormatError('expected format v4 header')
  },
})
