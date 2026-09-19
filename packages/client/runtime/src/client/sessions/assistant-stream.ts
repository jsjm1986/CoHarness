/**
 * Presentation fold joining transient `session/assistant-stream` frames to
 * their durable settlement. The Session's durable spine stays `SessionEvent`
 * only; this fold produces the visible window — durable entries plus
 * `assistant/live-chunk` transient rows — and releases each staged settlement
 * when its attempt's `end` frame commits.
 *
 * @module @deepseek-ai/dsh-client-runtime/sessions/assistant-stream
 */

import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { AssistantLiveChunkEvent, SessionEventLike } from '../contract/conversation.ts'

/** One visible window entry produced by the fold: durable or transient. */
export interface SessionWindowEntry {
  readonly event: SessionEventLike
}

/** Durable Assistant event that atomically supersedes one attempt's transient rows. */
export interface AssistantSettlementEntry {
  readonly event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>
}

interface ActiveAttempt {
  readonly attemptId: LlmAttemptId
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
  nextIndex: number
}

/** One publication decision from the assistant stream fold. */
export type ClientAssistantStreamResult =
  | { readonly type: 'publish'; readonly entry: SessionWindowEntry }
  | {
    readonly type: 'settlement'
    readonly attemptId: LlmAttemptId
    readonly entry: AssistantSettlementEntry
  }
  | { readonly type: 'abandonment'; readonly attemptId: LlmAttemptId }
  | { readonly type: 'transient'; readonly entry: SessionWindowEntry }
  | { readonly type: 'rebaseline' }
  | undefined

/** Keeps transient Assistant presentation behind one settlement-aware interface. */
export class ClientAssistantStream {
  private activeAttempt: ActiveAttempt | undefined
  private readonly pending = new Map<number, AssistantSettlementEntry>()
  private publishedSeqs = new Set<number>()
  private durableCursor = -1
  private transientInGap = 0

  /**
   * Replace the durable window and adopt an optional reconnect baseline.
   * @param events - durable events in the replacement window.
   * @param baseline - compact prefix for an Assistant attempt that is still live.
   * @returns immediately visible durable entries plus reconstructed transient chunks.
   */
  replace(
    events: readonly SessionEvent[],
    baseline?: SessionAssistantStreamBaseline,
  ): readonly SessionWindowEntry[] {
    this.pending.clear()
    this.transientInGap = 0
    this.activeAttempt = undefined
    const opening = baseline?.activeAttempt
    if (opening !== undefined) {
      this.activeAttempt = {
        attemptId: opening.attemptId,
        startedAfterSeq: opening.startedAfterSeq,
        turn: opening.turn,
        step: opening.step,
        nextIndex: opening.nextIndex,
      }
    }
    const visible: SessionWindowEntry[] = events.map(event => ({ event }))
    this.publishedSeqs = new Set(events.map(event => event.seq))
    this.durableCursor = events.reduce((cursor, event) => Math.max(cursor, event.seq), -1)
    if (opening !== undefined) {
      for (const [index, member] of expandAssistantStream(opening.stream).entries()) {
        this.transientInGap += 1
        visible.push({ event: this.liveChunk(member, opening.attemptId, opening.turn, opening.step) })
        if (index + 1 >= opening.nextIndex) break
      }
    }
    return visible
  }

  /**
   * Stage one durable settlement while its matching live attempt is open.
   * @param event - newly followed durable event.
   * @returns a publication decision, or `undefined` when the event is staged
   *   for a later `end` frame instead of published now.
   */
  acceptDurable(event: SessionEvent): ClientAssistantStreamResult {
    this.durableCursor = Math.max(this.durableCursor, event.seq)
    this.transientInGap = 0
    const settlement = assistantSettlementEntry(event)
    if (settlement !== undefined && this.attemptForSettlement(settlement.event) !== undefined) {
      if (this.pending.has(event.seq)) return { type: 'rebaseline' }
      this.pending.set(event.seq, settlement)
      return undefined
    }
    return this.publish({ event })
  }

  /**
   * Fold one dense transient frame and release its named durable settlement.
   * @param frame - next Assistant stream frame received on the mux.
   * @returns a transient, publication, or rebaseline decision, or `undefined` when no entry becomes visible.
   */
  acceptFrame(frame: SessionAssistantStreamFrame): ClientAssistantStreamResult {
    switch (frame.type) {
      case 'start':
        if (this.activeAttempt !== undefined || this.pending.size > 0) return { type: 'rebaseline' }
        this.pending.clear()
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: frame.startedAfterSeq,
          turn: frame.turn,
          step: frame.step,
          nextIndex: 0,
        }
        return undefined
      case 'chunk': {
        const attempt = this.activeAttempt
        // A fold mounted after the host saw this attempt has no start frame
        // to reconstruct. Its durable settlement publishes directly; ignore
        // the transient suffix until the next known start.
        if (attempt === undefined || attempt.attemptId !== frame.attemptId) return undefined
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        attempt.nextIndex += 1
        this.transientInGap += 1
        return {
          type: 'transient',
          entry: {
            event: this.liveChunk(
              { time: frame.time, chunk: frame.chunk as never },
              frame.attemptId,
              attempt.turn,
              attempt.step,
            ),
          },
        }
      }
      case 'end': {
        const attempt = this.activeAttempt
        if (attempt === undefined || attempt.attemptId !== frame.attemptId) {
          return undefined
        }
        this.activeAttempt = undefined
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        if (frame.outcome.kind === 'abandoned') {
          return this.pending.size === 0
            ? { type: 'abandonment', attemptId: attempt.attemptId }
            : { type: 'rebaseline' }
        }
        if (this.publishedSeqs.has(frame.outcome.seq)) return undefined
        const entry = this.pending.get(frame.outcome.seq)
        if (entry === undefined
          || entry.event.type !== frame.outcome.eventType) {
          return { type: 'rebaseline' }
        }
        this.pending.delete(frame.outcome.seq)
        this.publishedSeqs.add(entry.event.seq)
        return { type: 'settlement', attemptId: attempt.attemptId, entry }
      }
    }
  }

  private liveChunk(
    member: { readonly time: number; readonly chunk: AssistantLiveChunkEvent['data']['chunk'] },
    attemptId: LlmAttemptId,
    turn: number,
    step: number,
  ): AssistantLiveChunkEvent {
    return {
      type: 'assistant/live-chunk',
      seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
      time: member.time,
      data: { attemptId, turn, step, chunk: member.chunk },
    }
  }

  private attemptForSettlement(
    event: AssistantSettlementEntry['event'],
  ): ActiveAttempt | undefined {
    const attempt = this.activeAttempt
    if (attempt === undefined
      || (event.type === 'assistant/message' && event.surfaceOp !== 'append')
      || event.seq <= attempt.startedAfterSeq
      || attempt.turn !== event.data.turn
      || attempt.step !== event.data.step) return undefined
    return attempt
  }

  private publish(entry: SessionWindowEntry): ClientAssistantStreamResult {
    if (entry.event.type !== 'assistant/live-chunk') this.publishedSeqs.add(entry.event.seq)
    return { type: 'publish', entry }
  }
}

function assistantSettlementEntry(
  event: SessionEvent,
): AssistantSettlementEntry | undefined {
  return event.type === 'assistant/message' || event.type === 'assistant/attempt'
    ? { event }
    : undefined
}
