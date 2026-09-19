/**
 * Process-local assistant-stream state retained for reconnecting mux
 * subscribers. One accumulator per session folds dense `agent/assistant-stream`
 * frames and materializes an immutable subscribe baseline; live frames forward
 * verbatim with the durable cursor the host observed at emission.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/assistant-stream
 */

import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from './api/events.ts'

interface MutableAttempt {
  readonly attemptId: LlmAttemptId
  readonly startedAfterSeq: SessionSeqCursor
  readonly turn: number
  readonly step: number
  readonly stream: AssistantStreamAccumulator
  nextIndex: number
}

const EMPTY_BASELINE: SessionAssistantStreamBaseline = { revision: 0 }

/**
 * Fold dense Agent frames and materialize one shared immutable reconnect
 * baseline per accepted revision.
 */
export class SessionAssistantStreamAccumulator {
  private activeAttempt: MutableAttempt | undefined
  private revision = 0
  private snapshotValue: SessionAssistantStreamBaseline = EMPTY_BASELINE
  private dirty = false

  /**
   * Fold one trusted frame from the current attached Agent lifecycle.
   * @param frame - next dense process-local Assistant frame.
   * @param durableCursor - last committed Session seq when this frame was observed.
   */
  accept(frame: AssistantStreamFrame, durableCursor: SessionSeqCursor): void {
    if (frame.type === 'start' && frame.revision === 1 && this.revision !== 0) {
      this.activeAttempt = undefined
      this.revision = 0
    }
    if (frame.revision !== this.revision + 1) {
      this.activeAttempt = undefined
      this.revision = frame.revision
      this.dirty = true
      return
    }
    this.revision = frame.revision
    switch (frame.type) {
      case 'start':
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: durableCursor,
          turn: frame.turn,
          step: frame.step,
          stream: new AssistantStreamAccumulator(),
          nextIndex: 0,
        }
        break
      case 'chunk': {
        const attempt = this.activeAttempt
        if (attempt === undefined
          || attempt.attemptId !== frame.attemptId
          || frame.index !== attempt.nextIndex) {
          this.activeAttempt = undefined
          break
        }
        attempt.stream.push({ time: frame.time, chunk: frame.chunk })
        attempt.nextIndex += 1
        break
      }
      case 'end':
        this.activeAttempt = undefined
        break
    }
    this.dirty = true
  }

  /**
   * Read the cached reconnect baseline, materializing it after a state change.
   * @returns the identity-stable baseline for the latest accepted revision.
   */
  snapshot(): SessionAssistantStreamBaseline {
    if (!this.dirty) return this.snapshotValue
    this.snapshotValue = {
      revision: this.revision,
      ...this.activeAttempt === undefined ? {} : {
        activeAttempt: {
          attemptId: this.activeAttempt.attemptId,
          startedAfterSeq: this.activeAttempt.startedAfterSeq,
          turn: this.activeAttempt.turn,
          step: this.activeAttempt.step,
          nextIndex: this.activeAttempt.nextIndex,
          stream: this.activeAttempt.stream.snapshot(),
        },
      },
    }
    this.dirty = false
    return this.snapshotValue
  }
}

/** Baseline plus the count of accepted frames it covers, for live-frame cuts. */
export interface AssistantStreamSnapshot {
  readonly baseline: SessionAssistantStreamBaseline
  /** Number of frames folded so far; frames at or below it are baseline-covered. */
  readonly ordinal: number
}

interface SessionStreamState {
  readonly accumulator: SessionAssistantStreamAccumulator
  ordinal: number
}

/** Per-session accumulators owned by the mux domain. */
export class AssistantStreamRegistry {
  private readonly streams = new Map<SessionId, SessionStreamState>()

  /**
   * Fold one `agent/assistant-stream` emission into the owning session's
   * accumulator, creating it on first sight.
   * @param agent - the agent whose attempt produced the frame.
   * @param frame - next dense process-local Assistant frame.
   * @returns the frame's per-session ordinal for baseline coverage cuts.
   */
  accept(agent: Agent, frame: AssistantStreamFrame): number {
    let state = this.streams.get(agent.session.id)
    if (state === undefined) {
      state = { accumulator: new SessionAssistantStreamAccumulator(), ordinal: 0 }
      this.streams.set(agent.session.id, state)
    }
    state.ordinal += 1
    state.accumulator.accept(frame, cursorBeforeNext(agent.session.seq))
    return state.ordinal
  }

  /**
   * Read one session's reconnect baseline and the frame count it covers.
   * @param sessionId - the session to snapshot.
   * @returns the latest baseline with its coverage ordinal.
   */
  snapshot(sessionId: SessionId): AssistantStreamSnapshot {
    const state = this.streams.get(sessionId)
    return state === undefined
      ? { baseline: EMPTY_BASELINE, ordinal: 0 }
      : { baseline: state.accumulator.snapshot(), ordinal: state.ordinal }
  }

  /**
   * Drop a session's retained stream state at lifecycle end.
   * @param sessionId - the disposed session.
   */
  forget(sessionId: SessionId): void {
    this.streams.delete(sessionId)
  }
}

/**
 * Convert one process-local frame to its wire form: the start frame gains the
 * durable cursor it was observed at; chunk's provider vocabulary crosses as
 * JsonValue; end passes through with its settlement or abandonment.
 * @param frame - next dense process-local Assistant frame.
 * @param durableCursor - last committed Session seq when this frame was observed.
 * @returns the frame in mux wire form.
 */
export function wireStreamFrame(
  frame: AssistantStreamFrame,
  durableCursor: SessionSeqCursor,
): SessionAssistantStreamFrame {
  if (frame.type === 'start') return { ...frame, startedAfterSeq: durableCursor }
  if (frame.type === 'end') return frame
  return { ...frame, chunk: frame.chunk as JsonValue }
}

function cursorBeforeNext(nextSeq: number): SessionSeqCursor {
  return nextSeq === 0 ? -1 : SessionSeq(nextSeq - 1)
}

/**
 * Read the durable cursor a stream frame observes on its session: the last
 * committed seq, or -1 when the log is still empty.
 * @param session - the session the frame's attempt runs on.
 * @returns the cursor {@link wireStreamFrame} stamps on start frames.
 */
export function streamDurableCursor(session: Session): SessionSeqCursor {
  return cursorBeforeNext(session.seq)
}
