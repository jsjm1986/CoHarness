/** Exact-parent one-shot occupation survives cleanup failure until a confirmed release. */
import { renderSubagentFailure } from './error.ts'
import type { SubagentRun } from './types.ts'

/** One retained run's shared cleanup attempt and last failure state. */
export interface SubagentRunLease {
  /** Whether the last completed disposal failed to confirm release. */
  cleanupFailed: boolean
  /** Whether the caller handed failed cleanup back to the runtime. */
  retryOnAdmission: boolean
  /** Transfer failed cleanup to the runtime's retained recovery set. */
  adopt(): void
  /** Wait for confirmed release, including a later retained cleanup attempt. */
  whenReleased(): Promise<void>
  /** Retry cleanup, coalescing pending calls and retaining successful completion. */
  dispose(this: void): Promise<void>
}

/**
 * Retain a published run in its exact parent's occupation set.
 * @param owned - leases belonging to the exact parent object.
 * @param adopted - runtime-owned cleanup joined during service disposal.
 * @param run - provider-published one-shot handle.
 * @returns retained lease whose successful disposal removes its occupation.
 */
export function retainSubagentRun(
  owned: Set<SubagentRunLease>, adopted: Set<SubagentRunLease>, run: SubagentRun,
): SubagentRunLease {
  let disposal: Promise<void> | undefined
  let released: PromiseWithResolvers<undefined> | undefined
  const lease: SubagentRunLease = {
    cleanupFailed: false,
    retryOnAdmission: false,
    adopt: () => {
      if (!lease.cleanupFailed) return
      lease.retryOnAdmission = true
      adopted.add(lease)
    },
    whenReleased: () => {
      if (!owned.has(lease)) return Promise.resolve()
      return (released ??= Promise.withResolvers<undefined>()).promise
    },
    dispose: () => disposal ??= Promise.resolve().then(() => run.dispose()).then(() => {
      lease.cleanupFailed = false
      lease.retryOnAdmission = false
      owned.delete(lease)
      adopted.delete(lease)
      released?.resolve(undefined)
    }, (error: unknown) => {
      lease.cleanupFailed = true
      disposal = undefined
      throw error
    }),
  }
  owned.add(lease)
  return lease
}

/**
 * Resolve known failed cleanup before another provider admission for the same parent.
 * @param owned - retained leases belonging to the owner being recovered.
 * @throws an aggregate error when any retained cleanup remains unconfirmed.
 */
export async function retryFailedSubagentRuns(owned: ReadonlySet<SubagentRunLease>): Promise<void> {
  const failures = await Promise.allSettled([...owned]
    .filter(lease => lease.cleanupFailed && lease.retryOnAdmission).map(lease => lease.dispose()))
  const errors = failures.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (errors.length > 0) throw new AggregateError(errors,
    `Subagent cleanup is unconfirmed; retry delegation after resolving cleanup: ${errors.map(renderSubagentFailure).join('; ')}`)
}
