/**
 * Single replay-aware token-meter service for request and surface pressure.
 *
 * @module @deepseek-ai/dsh-token-meter
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  EpochHeader,
  Session,
  SessionEvent,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeq as SessionSeqType,
} from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals, isSurfaceEvent, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
// Type-only: resolves the optional projection registry Context declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  TokenMeasurement,
  TokenMeasurementBaseline,
  TokenMeterConfig,
  TokenSurfaceNode,
} from './types.ts'
import { contextBreakdownProjectionDefinition } from './breakdown-projection.ts'
import { contextPressureProjectionDefinition, tokenUsageProjectionDefinition } from './usage-projection.ts'
import { estimateHeader, estimateMessage } from './estimate.ts'
import { foldSurfaceTokens } from './surface-fold.ts'
import { priceSurface } from './route-pricing.ts'

export type * from './types.ts'

interface MeasurementAnchor {
  readonly header: EpochHeader | undefined
  readonly surfaceTokens: number
  readonly surfaceNodes: readonly TokenSurfaceNode[]
  readonly baseline: Exclude<TokenMeasurementBaseline, { kind: 'none' }>
}

interface ReplayState {
  consumedEvents: SessionLogOffsetType
  header: EpochHeader | undefined
  surface: TokenSurfaceNode[]
  surfaceTokens: number
  stepStart: { turn: number; step: number; surfaceTokens: number } | undefined
  anchor: MeasurementAnchor | undefined
}

/** Sum disjoint provider usage buckets without double-counting reasoning output. */
function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/** Compare optional envelopes so a headerless estimate can track later surface deltas. */
function optionalHeaderEquals(
  left: EpochHeader | undefined,
  right: EpochHeader | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return headerEquals(left, right)
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config: TokenMeterConfig): void {
  for (const key of Object.keys(config)) {
    throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenMeter: TokenMeter
  }
}

/** Replay owner for one service-wide estimator and isolated per-session folds. */
export class TokenMeter extends Service {
  // Schemastery preserves untrusted loader keys on an empty object schema;
  // the public type excludes settings while validateConfigKeys rejects them.
  static Config: z<TokenMeterConfig> = z.object({}) as unknown as z<TokenMeterConfig>

  private readonly states = new WeakMap<Session, ReplayState>()

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    validateConfigKeys(config)

    // Projection registration is an optional child: compositions without the
    // generic registry keep the meter's standalone read shape.
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(tokenUsageProjectionDefinition)
      projectionCtx.sessionProjections.register(contextPressureProjectionDefinition)
      projectionCtx.sessionProjections.register(contextBreakdownProjectionDefinition)
    })

    // Readers catch up independently, while eager observation bounds ordinary
    // read latency without creating state for sessions no consumer has read.
    ctx.on('session/event', (session) => {
      if (this.states.has(session)) this._sync(session)
    })
  }

  /**
   * Measure current request pressure and surface through the durable tail.
   *
   * Provider usage is reused only when the latest successful call's canonical
   * request envelope matches `requestHeader` and its total is no lower than
   * that call's full heuristic anchor; otherwise the complete envelope and
   * surface are heuristically repriced.
   *
   * `requestHeader` affects request pressure only; surface fields always
   * describe the current session surface. Every call clones those positional
   * nodes, so measurement is O(surface).
   *
   * @param session - session to replay through its current durable tail.
   * @param requestHeader - optional effective request envelope replacing the latest logged header.
   * @returns a detached deeply immutable pressure and surface measurement.
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this._sync(session)
    const header = requestHeader === undefined
      ? state.header
      : canonicalHeader(requestHeader)
    const anchor = state.anchor
    const pricing = this._routeImagePricing(header)
    const priced = priceSurface(state.surface, pricing)

    let baseline: TokenMeasurementBaseline
    let surfaceDeltaTokens: number
    if (anchor !== undefined && optionalHeaderEquals(anchor.header, header)) {
      baseline = anchor.baseline
      const anchorSurfaceTokens = priceSurface(anchor.surfaceNodes, pricing).surfaceTokens
      surfaceDeltaTokens = priced.surfaceTokens - anchorSurfaceTokens
    } else if (header === undefined && priced.surfaceTokens === 0) {
      baseline = { kind: 'none', tokens: 0 }
      surfaceDeltaTokens = 0
    } else {
      baseline = {
        kind: 'estimated',
        tokens: estimateHeader(header) + priced.surfaceTokens,
      }
      surfaceDeltaTokens = 0
    }

    return deepFreeze(structuredClone({
      logRevision: state.consumedEvents,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
      surfaceTokens: priced.surfaceTokens,
      nodes: priced.nodes,
    }))
  }

  /** Resolve synchronous provider image pricing for the current route. */
  private _routeImagePricing(header: EpochHeader | undefined) {
    const config = header?.config
    if (config === undefined) return undefined
    return this.ctx.get('llm')?.imageRequestPricing(config.provider, config.model)
  }

  /**
   * Heuristically price one model-visible message (instance face of the pure
   * `estimateMessage` export from `estimate.ts`).
   * @param message - message to price without mutation.
   * @returns content and role-framing tokens under the fixed service heuristic.
   */
  estimateMessage(message: Message): number {
    return estimateMessage(message)
  }

  /** Catch one session's fold up to the current durable tail. */
  private _sync(session: Session): ReplayState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumedEvents: SessionLogOffset(0),
        header: undefined,
        surface: [],
        surfaceTokens: 0,
        stepStart: undefined,
        anchor: undefined,
      }
      this.states.set(session, state)
    }

    while (state.consumedEvents < session.seq) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous session seqs index the durable log
      const event = session.eventAt(SessionSeq(state.consumedEvents))!
      this._foldEvent(session, state, event)
      state.consumedEvents = SessionLogOffset(state.consumedEvents + 1)
    }
    return state
  }

  /**
   * Validate and prepare every fallible part before mutating replay state.
   * A malformed event remains unread on every retry instead of partially
   * applying the same mutation more than once.
   */
  private _foldEvent(session: Session, state: ReplayState, event: SessionEvent): void {
    let nextHeader = state.header
    let nextStepStart = state.stepStart
    let nextAnchor = state.anchor

    switch (event.type) {
      case 'request/header':
        nextHeader = canonicalHeader(event.data.header)
        break
      case 'step/start':
        if (state.stepStart !== undefined) {
          throw new Error(
            `token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`,
          )
        }
        nextStepStart = { ...event.data, surfaceTokens: state.surfaceTokens }
        break
      case 'step/end':
        if (state.stepStart === undefined
          || state.stepStart.turn !== event.data.turn
          || state.stepStart.step !== event.data.step) {
          throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`)
        }
        nextStepStart = undefined
        break
      default:
        break
    }

    const surfaceEvent = isSurfaceEvent(event) ? event : undefined
    const surface = surfaceEvent === undefined
      ? undefined
      : foldSurfaceTokens(state.surface, surfaceEvent)

    if (event.type === 'assistant/message') {
      const stepStart = state.stepStart
      if (stepStart === undefined
        || stepStart.turn !== event.data.turn
        || stepStart.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`)
      }
      /* v8 ignore next 3 -- Session rejects a surface-eligible append or seed without its surfaceOp marker before it reaches the log. */
      if (surfaceEvent === undefined || surface === undefined) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} is missing its surfaceOp marker`)
      }

      // assistant/message is surface-mandatory at every append/seed boundary.
      const eventTokens = surface.tokens
      if (event.data.usage !== undefined && nextHeader !== undefined) {
        const providerAssistant = this._providerAssistantMessage(session, event)
        const providerAssistantTokens = providerAssistant.message === null
          ? 0
          : estimateMessage(providerAssistant.message)
        const anchorSurfaceTokens = stepStart.surfaceTokens + providerAssistantTokens
        const providerTokens = usageTokens(event.data.usage)
        const estimatedAnchorTokens = estimateHeader(nextHeader) + anchorSurfaceTokens
        const providerSurface = foldSurfaceTokens(state.surface, surfaceEvent, providerAssistant.message)
        nextAnchor = {
          header: nextHeader,
          surfaceTokens: anchorSurfaceTokens,
          surfaceNodes: providerSurface.nodes,
          // Signed heuristic deltas remain conservative only from an anchor
          // that is at least as large as the matching full heuristic price.
          baseline: providerTokens >= estimatedAnchorTokens
            ? { kind: 'usage', tokens: providerTokens, usage: event.data.usage }
            : { kind: 'estimated', tokens: estimatedAnchorTokens },
        }
      } else {
        const anchorSurfaceTokens = stepStart.surfaceTokens + eventTokens
        nextAnchor = {
          header: nextHeader,
          surfaceTokens: anchorSurfaceTokens,
          surfaceNodes: surface.nodes,
          baseline: {
            kind: 'estimated',
            tokens: estimateHeader(nextHeader) + anchorSurfaceTokens,
          },
        }
      }
    }

    state.header = nextHeader
    state.stepStart = nextStepStart
    if (surface !== undefined) {
      state.surface = surface.nodes
      state.surfaceTokens += surface.deltaTokens
    }
    state.anchor = nextAnchor
  }

  /**
   * Reassemble provider output from the exact cited chunk seqs for a usage anchor.
   * Missing legacy source seqs conservatively treat the durable output as the
   * provider output; an explicit empty list prices a known empty stream.
   */
  private _providerAssistantMessage(
    session: Session,
    event: SessionEvent<'assistant/message'>,
  ): { readonly message: Message | null } {
    const sourceSeqs = event.sourceEventSeqs
    if (sourceSeqs === undefined) return { message: event.data.message }

    const assembler = new BlockAssembler()
    const seen = new Set<SessionSeqType>()
    for (const seq of sourceSeqs) {
      if (seq >= event.seq) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} is not earlier`)
      }
      if (seen.has(seq)) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} repeats source seq ${seq}`)
      }
      seen.add(seq)
      // Session construction validates contiguous seqs, and the explicit
      // earlier-than-assistant check above therefore guarantees existence.
      const source = session.eventAt(seq)
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const sourceEvent = source!
      if (sourceEvent.type !== 'assistant/chunk') {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} is not assistant/chunk`)
      }
      if (sourceEvent.data.turn !== event.data.turn || sourceEvent.data.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} belongs to another step`)
      }
      assembler.push(sourceEvent.data.chunk)
    }
    const providerContent = assembler.blocks()
    if (providerContent.length === 0) return { message: null }
    return { message: { ...event.data.message, content: providerContent } }
  }
}

export default TokenMeter
