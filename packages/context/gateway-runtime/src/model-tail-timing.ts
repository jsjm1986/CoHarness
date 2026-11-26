/**
 * Post-stream turn-tail timing observer for managed runtimes.
 * Correlates model resource completion with session commit and turn settlement on one Runtime clock.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResourceOperationId } from '@deepseek-ai/dsh-resource-budget'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** Completion metadata forwarded from the resource provider on the same monotonic clock. */
export interface ModelResourceFinishSample {
  readonly sessionId: SessionId
  readonly operationId: ResourceOperationId
  readonly outcome: 'not-started' | 'quiescent' | 'uncertain'
  readonly acknowledged: boolean
  readonly retry: boolean
  readonly startedAt: number
  readonly finishedPerf: number
  readonly elapsedMs: number
}

const MODEL_RESOURCE_FINISH_RECORDER = Symbol.for('dsh.gateway-runtime.model-resource-finish-recorder')

interface ModelResourceFinishHost {
  readonly [MODEL_RESOURCE_FINISH_RECORDER]?: (sample: ModelResourceFinishSample) => void
}

/**
 * Bind a package-internal model resource completion recorder to a GatewayRuntime instance.
 * @param target - GatewayRuntime instance owning the observer lifetime.
 * @param recorder - observer callback returned by {@link installModelTurnTailObserver}.
 */
export function attachModelResourceFinishRecorder(
  target: object,
  recorder: (sample: ModelResourceFinishSample) => void,
): void {
  Object.defineProperty(target, MODEL_RESOURCE_FINISH_RECORDER, {
    configurable: true,
    writable: true,
    value: recorder,
  })
}

/**
 * Forward a settled model resource completion sample to the runtime's observer when installed.
 * @param target - GatewayRuntime instance supplied by the resource budget provider.
 * @param sample - runtime-clock completion metadata for a session-scoped model reservation.
 */
export function recordModelResourceFinish(target: object, sample: ModelResourceFinishSample): void {
  const recorder = (target as ModelResourceFinishHost)[MODEL_RESOURCE_FINISH_RECORDER]
  if (recorder !== undefined) recorder(sample)
}

interface SettledStepTail {
  readonly step: number
  readonly assistantEventType: 'assistant/message' | 'assistant/attempt'
  readonly assistantSeq: number
  readonly assistantToStepEndMs?: number
  readonly resourceOperationId?: ResourceOperationId
  readonly resourceFinishOutcome?: 'not-started' | 'quiescent' | 'uncertain'
  readonly resourceFinishAcknowledged?: boolean
  readonly resourceFinishElapsedMs?: number
  readonly resourceFinishToAssistantMs?: number
}

interface ActiveAssistantStep {
  readonly eventType: 'assistant/message' | 'assistant/attempt'
  readonly seq: number
  readonly step: number
  readonly perf: number
  readonly resourceFinish: ModelResourceFinishSample | undefined
}

interface ActiveTurnTail {
  readonly turn: number
  readonly startedAt: number
  readonly turnStartPerf: number
  stepCount: number
  lastStep?: number | undefined
  readonly steps: SettledStepTail[]
  lastResourceFinish?: ModelResourceFinishSample | undefined
  lastAssistant?: ActiveAssistantStep | undefined
  stepEndPerf?: number | undefined
}

const MAX_TRACKED_SESSIONS = 1024
const MAX_TRACKED_STEPS = 16
const round = (ms: number): number => Math.round(Math.max(0, ms) * 100) / 100
/**
 * Subscribe to post-commit session events and emit `[model-turn-tail-timing]` on `turn/end`.
 * Carries no prompts, replies, or session identifiers.
 * @param ctx - GatewayRuntime context owning the listener lifetime.
 * @returns recorder for settled session-scoped model resource completions.
 */
export function installModelTurnTailObserver(ctx: Context): (sample: ModelResourceFinishSample) => void {
  const turns = new Map<SessionId, ActiveTurnTail>()
  const onFinish = (sample: ModelResourceFinishSample): void => {
    if (sample.retry) return
    const active = turns.get(sample.sessionId)
    if (active !== undefined) active.lastResourceFinish = sample
  }
  ctx.effect(() => () => { turns.clear() }, 'gateway-runtime: model turn-tail timing')

  ctx.on('session/disposed', (session: Session) => {
    turns.delete(session.id)
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      const now = performance.now()
      if (event.type === 'turn/start') {
        if (!turns.has(session.id) && turns.size >= MAX_TRACKED_SESSIONS) {
          for (const oldest of turns.keys()) {
            turns.delete(oldest)
            break
          }
        }
        turns.set(session.id, { turn: event.data.turn, startedAt: Date.now(), turnStartPerf: now, stepCount: 0, steps: [] })
        return
      }
      const active = turns.get(session.id)
      if (active === undefined) return
      if (event.type === 'step/start') {
        active.lastAssistant = undefined
        active.lastResourceFinish = undefined
        active.stepEndPerf = undefined
        return
      }
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        if (active.lastStep !== event.data.step) {
          active.stepCount += 1
          active.lastStep = event.data.step
        }
        active.lastAssistant = {
          eventType: event.type,
          seq: event.seq,
          step: event.data.step,
          perf: now,
          resourceFinish: active.lastResourceFinish,
        }
        active.lastResourceFinish = undefined
        active.stepEndPerf = undefined
        return
      }
      if (event.type === 'step/end') {
        const assistant = active.lastAssistant
        if (assistant !== undefined && assistant.step === event.data.step) {
          active.stepEndPerf = now
          if (active.steps.length < MAX_TRACKED_STEPS) {
            const finish = assistant.resourceFinish
            active.steps.push({
              step: assistant.step,
              assistantEventType: assistant.eventType,
              assistantSeq: assistant.seq,
              assistantToStepEndMs: round(now - assistant.perf),
              ...(finish === undefined ? {} : {
                resourceOperationId: finish.operationId,
                resourceFinishOutcome: finish.outcome,
                resourceFinishAcknowledged: finish.acknowledged,
                resourceFinishElapsedMs: round(finish.elapsedMs),
                resourceFinishToAssistantMs: round(assistant.perf - finish.finishedPerf),
              }),
            })
          }
        }
        return
      }
      if (event.type === 'turn/end') {
        turns.delete(session.id)
        const assistant = active.lastAssistant
        const finish = assistant !== undefined ? assistant.resourceFinish : active.lastResourceFinish
        const payload = {
          turn: active.turn,
          reason: event.data.reason.kind,
          startedAt: active.startedAt,
          turnElapsedMs: round(now - active.turnStartPerf),
          ...(active.stepCount > 1 ? { stepCount: active.stepCount, steps: active.steps } : {}),
          ...(assistant === undefined ? {} : {
            assistantEventType: assistant.eventType,
            assistantSeq: assistant.seq,
            step: assistant.step,
            assistantToTurnEndMs: round(now - assistant.perf),
            ...(active.stepEndPerf === undefined ? {} : {
              assistantToStepEndMs: round(active.stepEndPerf - assistant.perf),
              stepEndToTurnEndMs: round(now - active.stepEndPerf),
            }),
          }),
          ...(finish === undefined ? {} : {
            resourceOperationId: finish.operationId,
            resourceFinishOutcome: finish.outcome,
            resourceFinishAcknowledged: finish.acknowledged,
            resourceFinishElapsedMs: round(finish.elapsedMs),
            ...(assistant === undefined ? {} : {
              resourceFinishToAssistantMs: round(assistant.perf - finish.finishedPerf),
            }),
            resourceFinishToTurnEndMs: round(now - finish.finishedPerf),
          }),
        }
        console.info(`[model-turn-tail-timing] ${JSON.stringify(payload)}`)
      }
    } catch { /* Diagnostic output cannot interrupt committed session events. */ }
  })
  return onFinish
}
