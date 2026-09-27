/**
 * Bench adapter for the Session opening history path.
 *
 * CoHarness serves Session history through `ctx.sessionQuery` observation
 * (host/apiproxy) instead of an api/session-controller package, so this
 * adapter keeps the upstream worker's `follow()` surface while measuring the
 * local production observation path.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { modelSelectionProjectionDefinition } from '../../packages/host/apiproxy/src/model-selection-projection.ts'

/** Follow request scoped to one Session; the only address the benchmark issues. */
export interface SessionOpenFollowRequest {
  readonly address: {
    readonly kind: 'session'
    readonly sessionId: SessionId
  }
}

/** Opening frame carrying the complete retained event list for the Session. */
export interface SessionOpenSnapshotFrame {
  readonly type: 'snapshot'
  readonly records: readonly SessionEvent[]
}

/**
 * Session-history source over the `ctx.sessionQuery` cold-observation path.
 * `follow()` delivers one complete snapshot then parks on cancellation;
 * `promote` runs only when the consumer pulls past the snapshot, matching the
 * upstream controller's activation hand-off.
 */
export class SessionHistoryController {
  /**
   * @param ctx - Host context carrying the mounted `sessionQuery` service.
   * @param promote - starts ordinary Session activation after snapshot delivery.
   */
  constructor(
    private readonly ctx: Context,
    private readonly promote: (observation: SessionObservation) => void,
  ) {}

  /**
   * Resolve one exact Session cut and stream its opening snapshot.
   * @param request - Session address to observe.
   * @param signal - cancellation ending the parked follow.
   * @returns an async iterable whose first frame is the complete snapshot.
   */
  async *follow(
    request: SessionOpenFollowRequest,
    signal: AbortSignal,
  ): AsyncIterable<SessionOpenSnapshotFrame> {
    const observation = await this.ctx.sessionQuery.observeSession(
      request.address.sessionId,
      { signal, projectionMode: 'all' },
    )
    try {
      yield { type: 'snapshot', records: observation.events }
      const promotion = observation.retain()
      try {
        this.promote(promotion)
      } catch (error: unknown) {
        promotion[Symbol.dispose]()
        throw error
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    } finally {
      observation[Symbol.dispose]()
    }
  }
}

/**
 * Register the durable model-selection projection when the registry is present.
 * @param ctx - Host context carrying the `sessionProjections` registry.
 */
export function installModelSelectionProjection(ctx: Context): void {
  ctx.sessionProjections.register(modelSelectionProjectionDefinition)
}
