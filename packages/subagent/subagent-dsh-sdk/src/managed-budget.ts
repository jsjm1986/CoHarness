/** Child resource provider reporting real cleanup through its parent SDK owner. */
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import type { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import ResourceBudget, { ResourceAdmissionError, type ResourceLease, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import type { SdkControlId } from './control.ts'
import type { ParentControlClient } from './managed-client.ts'

/** Current child model transaction; concurrent calls retain independent ownership. */
export interface ChildModelSpan { id: SdkControlId; controller: AbortController }
interface ChildLease {
  id: SdkControlId
  controller: AbortController
  watchStop: AbortController
  outcome?: 'released' | 'uncertain'
  acknowledged?: 'released' | 'uncertain'
  finish?: Promise<void>
  watch: Promise<void>
}

/** Process and model operations share parent admission, never the child profile's own independent budget. */
export class ManagedSdkBudget extends ResourceBudget {
  private readonly pending = new Set<Promise<ResourceLease>>()
  /** Operation ownership starts before publication and ends after completion acknowledgement. */
  private readonly leases = new Set<ChildLease>()
  private readonly lifetime = new AbortController()
  private cleanupWake: (() => void) | undefined
  private closing = false
  private closeTask: Promise<void> | undefined

  /**
   * @param ctx - child provider context.
   * @param client - private parent connection.
   * @param models - active model-call ownership.
   */
  constructor(ctx: Context, private readonly client: ParentControlClient,
    private readonly models: AsyncLocalStorage<ChildModelSpan>) { super(ctx) }

  async acquire(request: ResourceRequest): Promise<ResourceLease> {
    if (this.closing) throw new ResourceAdmissionError('unavailable', 'SDK child admission is stopping.')
    const work = this.acquireOwned(request)
    this.pending.add(work)
    try { return await work } finally { this.pending.delete(work) }
  }

  private async acquireOwned(request: ResourceRequest): Promise<ResourceLease> {
    const model = request.kind === 'model' ? this.models.getStore() : undefined
    const signal = AbortSignal.any([this.lifetime.signal, ...request.signal === undefined ? [] : [request.signal],
      ...model === undefined ? [] : [model.controller.signal]])
    signal.throwIfAborted()
    if (request.kind === 'model' && model === undefined) throw new ResourceAdmissionError('unavailable', 'SDK model request has no parent stream owner.')
    await this.client.retryModelCompletions()
    await this.retryReports()
    signal.throwIfAborted()
    const started = this.client.register('/resource/register', { kind: request.kind,
      ...request.kind === 'model' ? { modelId: model?.id } : {},
    }, signal)
    const controller = new AbortController()
    const lease: ChildLease = { id: started.id, controller, watchStop: new AbortController(), watch: Promise.resolve() }
    this.leases.add(lease)
    try {
      await started.ready
      for (;;) {
        signal.throwIfAborted()
        const state = await this.client.post('/resource/status', { id: started.id }, signal)
        if (state.state === 'granted') break
        if (state.state !== 'waiting') {
          const reason = state.state === 'failed' && ['unavailable', 'cancelled', 'expired', 'refused'].includes(String(state.reason))
            ? state.reason as ResourceAdmissionError['reason'] : 'cancelled'
          throw new ResourceAdmissionError(reason, 'SDK parent resource admission did not grant the request.')
        }
        await delay(this.client.connection.config.pollMs, undefined, { signal })
      }
      signal.throwIfAborted()
      const effective = AbortSignal.any([controller.signal, signal])
      lease.watch = this.watch(lease)
      return { signal: effective, release: () => this.finish(lease, 'released'), uncertain: () => this.finish(lease, 'uncertain') }
    } catch (error) {
      try { await this.finish(lease, 'released') } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'SDK resource admission and cancellation reporting failed.')
      }
      throw error
    }
  }

  private async retryReports(): Promise<void> {
    const results = await Promise.allSettled([...this.leases].flatMap(lease =>
      lease.outcome === undefined ? [] : [this.finish(lease, lease.outcome)]))
    const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'SDK prior resource completion could not be acknowledged.')
  }

  private async watch(lease: ChildLease): Promise<void> {
    try {
      while (!lease.watchStop.signal.aborted) {
        const state = await this.client.post('/resource/status', { id: lease.id }, lease.watchStop.signal)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Parent I/O can overlap final release or provider closure.
        if (lease.watchStop.signal.aborted) return
        if (state.state !== 'granted') throw new ResourceAdmissionError('cancelled', 'SDK parent resource permit was withdrawn.')
        await delay(this.client.connection.config.pollMs, undefined, { signal: lease.watchStop.signal })
      }
    } catch (error) {
      if (!lease.watchStop.signal.aborted) lease.controller.abort(error)
    }
  }

  private finish(lease: ChildLease, outcome: 'released' | 'uncertain'): Promise<void> {
    lease.outcome = outcome === 'released' || lease.outcome === 'released' ? 'released' : 'uncertain'
    this.leases.add(lease)
    this.cleanupWake?.()
    lease.finish = (lease.finish ?? Promise.resolve()).catch(() => {
      // A later report retries the same permit without losing proven quiescence.
    }).then(async () => {
      const reported = lease.outcome === 'released' ? 'released' : 'uncertain'
      if (reported === 'released') lease.watchStop.abort(new ResourceAdmissionError('cancelled', 'SDK resource cleanup was reported.'))
      if (lease.acknowledged !== 'released' && lease.acknowledged !== reported) {
        await this.client.post('/resource/finish', { id: lease.id, outcome: reported })
        lease.acknowledged = reported
      }
      if (lease.acknowledged === 'released') this.leases.delete(lease)
      this.cleanupWake?.()
    })
    return lease.finish
  }

  /**
   * Cancel remaining execution; only consumers may prove quiescence.
   * @returns reports joined within the control deadline; failures retain original permits for retry.
   */
  close(): Promise<void> {
    this.closeTask ??= this.client.cleanup(deadline => this.closeOwned(deadline)).finally(() => {
      this.closeTask = undefined
    })
    return this.closeTask
  }

  private async closeOwned(deadline: number): Promise<void> {
    this.closing = true
    this.lifetime.abort(new ResourceAdmissionError('cancelled', 'SDK child admission was unloaded.'))
    const owned = [...this.leases]
    for (const lease of this.leases) {
      lease.controller.abort(new ResourceAdmissionError('cancelled', 'SDK child admission was unloaded.'))
      lease.watchStop.abort(new ResourceAdmissionError('cancelled', 'SDK child admission was unloaded.'))
    }
    await Promise.allSettled([...this.pending])
    const consumerDeadline = deadline - this.client.connection.config.requestTimeoutMs
    while ([...this.leases].some(lease => lease.outcome === undefined) && performance.now() < consumerDeadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, consumerDeadline - performance.now()))
        this.cleanupWake = () => { clearTimeout(timer); resolve() }
      })
    }
    this.cleanupWake = undefined
    const results = await Promise.allSettled([...this.leases].map(lease => this.finish(lease, 'uncertain')))
    await Promise.allSettled(owned.map(lease => lease.watch))
    const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'SDK child resource reporting failed.')
  }
}
