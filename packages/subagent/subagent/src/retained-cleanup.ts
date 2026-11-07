/** Parent-owned recovery keeps failed one-shot cleanup reachable across runtime replacement. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderSubagentFailure } from './error.ts'

/** Exact-parent recovery registrations shared by one runtime's adopted leases. */
export interface SubagentCleanupRecovery {
  /**
   * Retain occupation and retry access until the original lease confirms release.
   * @param retry - original owner's coalescing cleanup operation.
   * @param released - non-rejecting confirmation of physical release.
   */
  retain(retry: () => Promise<void>, released: Promise<void>): void
}

/**
 * Own failed cleanup in the original parent scope, independently of the runtime
 * registration. Parent teardown retries retained cleanup before releasing the
 * recovery listeners; a failed retry remains adopted by the original runtime.
 * Empty recovery registrations release their listeners.
 * @param parent - exact Agent retaining cleanup authority and occupation.
 * @returns recovery that coalesces repeated transfers of the same lease.
 */
export function createSubagentCleanupRecovery(parent: Agent): SubagentCleanupRecovery {
  const retained = new Map<() => Promise<void>, Promise<void>>()
  let closed = false
  const retain = (retry: () => Promise<void>, released: Promise<void>): void => {
    if (retained.has(retry)) return
    retained.set(retry, released)
    void released.then(() => {
      retained.delete(retry)
      if (retained.size === 0) void dispose()
    })
  }
  const dispose = parent.ctx.effect(function* () {
    yield parent.ctx.on('agent/idle-release-check', ({ agent }) =>
      agent === parent && retained.size > 0 ? 'busy' : undefined, { global: true })
    yield parent.ctx.on('subagent/cleanup-retry', (target, register) => {
      if (target === parent && retained.size > 0) register(() => settleCleanupRetries(retained.keys()))
    }, { global: true })
    yield parent.ctx.on('subagent/cleanup-retain', (target, retry, released, claim) => {
      if (target === parent && !closed && claim()) retain(retry, released)
    }, { global: true })
    yield async () => {
      try {
        while (retained.size > 0) await settleCleanupRetries(retained.keys())
      } finally {
        closed = true
        retained.clear()
      }
    }
  }, 'subagent: parent-owned failed cleanup recovery')
  return { retain }
}

async function settleCleanupRetries(attempts: Iterable<() => Promise<void>>): Promise<void> {
  const outcomes = await Promise.allSettled([...attempts].map(retry => Promise.resolve().then(retry)))
  const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
  if (errors.length > 0) throw new AggregateError(errors,
    `Retained subagent cleanup is unconfirmed: ${errors.map(renderSubagentFailure).join('; ')}`)
}

/**
 * Retry retained cleanup before allocating new exact-parent work, including
 * cleanup owned by retired runtimes. Every collected attempt settles before a
 * refusal, and another collection observes transfers made during that wait.
 * @param ctx - admitting runtime's event context.
 * @param parent - exact Agent requesting allocation.
 * @returns after no retained cleanup remains; rejects while release is unconfirmed.
 */
export async function retryRetainedSubagentCleanup(ctx: Context, parent: Agent): Promise<void> {
  for (;;) {
    const attempts: Array<() => Promise<void>> = []
    ctx.emit('subagent/cleanup-retry', parent, (retry) => { attempts.push(retry) })
    if (attempts.length === 0) return
    await settleCleanupRetries(attempts)
  }
}
