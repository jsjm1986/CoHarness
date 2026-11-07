/** Process admission and provider-owned SDK child lifetime. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { resourceBudgetOf, ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import { requiresParentModelControl, type SubagentRun, type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SdkStartupCleanupError, startSdkRun, type SdkRunSpec } from './run.ts'
import { SdkParentControl } from './bridge.ts'
import type { ResourceBudget, ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import { executionAuthorityOf, sameExecutionAuthority, type ExecutionAuthority } from '@deepseek-ai/dsh-execution-authority'
import type { SdkControlConfig } from './control.ts'

interface StartAdmission {
  readonly budget: ResourceBudget | undefined
  assertCurrent(): void
}

/** Retain the initiating resource and execution owners before startup can await cleanup. */
function captureStartAdmission(ctx: Context, authority: ExecutionAuthority | undefined): StartAdmission {
  const budget = ctx.get('resourceBudget'), required = ctx.get('resourceBudgetRequired') === true
  const original = (value: ResourceBudget | undefined): ResourceBudget | undefined =>
    (value as (ResourceBudget & { [symbols.original]?: ResourceBudget }) | undefined)?.[symbols.original] ?? value
  return { budget, assertCurrent() {
    const current = resourceBudgetOf(ctx)
    if (original(current) !== original(budget) || required && current === undefined) {
      throw new ResourceAdmissionError('unavailable', 'SDK startup resource owner changed; retry with its current provider.')
    }
    if (!sameExecutionAuthority(executionAuthorityOf(ctx), authority)) {
      throw new ResourceAdmissionError('unavailable', 'SDK startup execution authority changed; retry with its current provider.')
    }
  } }
}

/** Pending starts and published SDK children owned by one provider fiber. */
export class SdkRunLifetime {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<SubagentRun>>()
  private readonly runs = new Set<SubagentRun>()
  private readonly unpublished = new Set<SdkStartupCleanupError>()

  /**
   * Join SDK child cleanup before releasing the provider context.
   * @param ctx - the SDK provider's owning context.
   * @param controlConfig - validated private parent-control limits.
   */
  constructor(private readonly ctx: Context, private readonly controlConfig: SdkControlConfig) {
    ctx.effect(() => async () => {
      this.lifetime.abort(new ResourceAdmissionError('cancelled', 'SDK subagent provider was unloaded.'))
      await Promise.allSettled([...this.pending])
      const outcomes = await Promise.allSettled([this.cleanupUnpublished(), ...[...this.runs].map(run => run.dispose())])
      const failures = outcomes.flatMap((outcome): unknown[] => outcome.status === 'rejected' ? [outcome.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'SDK subagent provider cleanup failed.')
    }, 'subagent-dsh-sdk.children()')
  }

  /**
   * Admit the actual SDK process and retain its permit through confirmed cleanup.
   * @param request - initiating parent and caller cancellation.
   * @param spec - resolved SDK process configuration.
   * @returns the published child with joined, idempotent disposal.
   */
  start(request: SubagentStartRequest, spec: SdkRunSpec): Promise<SubagentRun> {
    const authority = executionAuthorityOf(request.parent.ctx)
    const admission = captureStartAdmission(request.parent.ctx, authority)
    const scope = authority?.capture(request.parent)
    const pending = (authority === undefined || scope === undefined ? this.startOwned(request, spec, admission)
      : authority.runCaptured(request.parent, scope, () => this.startOwned(request, spec, admission))).catch((error: unknown) => {
      if (error instanceof SdkStartupCleanupError) this.unpublished.add(error)
      throw error
    })
    this.pending.add(pending)
    void pending.then(() => { this.pending.delete(pending) }, () => { this.pending.delete(pending) })
    return pending
  }

  private async cleanupUnpublished(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.unpublished].map(async (failure) => {
      await failure.cleanup()
      this.unpublished.delete(failure)
    }))
    const failures = outcomes.flatMap((outcome): unknown[] => outcome.status === 'rejected' ? [outcome.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'SDK unpublished startup cleanup could not be confirmed.')
  }

  private async startOwned(request: SubagentStartRequest, spec: SdkRunSpec, admission: StartAdmission): Promise<SubagentRun> {
    const ctx = request.parent.ctx
    const caller = AbortSignal.any([request.signal, this.lifetime.signal])
    caller.throwIfAborted()
    await this.cleanupUnpublished()
    caller.throwIfAborted()
    admission.assertCurrent()
    const lease = await admission.budget?.acquire({
      kind: 'process', origin: 'execution', sessionId: request.parent.id, signal: caller,
    })
    const signal = lease === undefined ? caller : AbortSignal.any([caller, lease.signal])
    let control: SdkParentControl | undefined
    const assertOwnership = (): void => {
      signal.throwIfAborted()
      spec.assertOwnership?.()
      admission.assertCurrent()
      signal.throwIfAborted()
    }
    let managedSpec: SdkRunSpec = { ...spec, assertOwnership }
    let ownedLease: ResourceLease | undefined = lease
    try {
      assertOwnership()
      if (requiresParentModelControl(ctx)) {
        control = new SdkParentControl(request, this.controlConfig)
        const managed = await control.open()
        assertOwnership()
        const bootstrap = control
        managedSpec = { ...managedSpec, env: { ...spec.env, ...managed.env }, onInitialized: () => {
          bootstrap.assertReady()
          spec.onInitialized?.()
        } }
      }
    } catch (error) {
      const outcomes = await Promise.allSettled([control?.close(), lease?.release()])
      const failures = outcomes.flatMap((outcome): unknown[] => outcome.status === 'rejected' ? [outcome.reason] : [])
      if (failures.length > 0) throw new SdkStartupCleanupError(
        new AggregateError([error, ...failures], 'SDK parent control startup and cleanup failed.'), async () => {
          const retried = await Promise.allSettled([control?.close(), lease?.release()])
          const remaining = retried.flatMap((outcome): unknown[] => outcome.status === 'rejected' ? [outcome.reason] : [])
          if (remaining.length > 0) throw new AggregateError(remaining, 'SDK parent control startup cleanup could not be confirmed.')
        })
      throw error
    }
    if (control !== undefined) {
      const owner = control
      ownedLease = {
        signal,
        release: async () => {
          const results = await Promise.allSettled([owner.close(), lease?.release()])
          const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
          if (failures.length === 1) throw failures[0]
          if (failures.length > 0) throw new AggregateError(failures, 'SDK parent control and process release failed.')
        },
        uncertain: async () => {
          const results = await Promise.allSettled([owner.close(), lease?.uncertain()])
          const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
          if (failures.length === 1) throw failures[0]
          if (failures.length > 0) throw new AggregateError(failures, 'SDK parent control and uncertain process reporting failed.')
        },
      }
    }
    const run = await startSdkRun({ ...request, signal }, managedSpec, ownedLease)
    try { assertOwnership() } catch (error) {
      try { await run.dispose() } catch (cleanupError) {
        throw new SdkStartupCleanupError(new AggregateError([error, cleanupError], 'SDK startup ownership and cleanup failed.'),
          () => run.dispose())
      }
      throw error
    }
    let disposal: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposal ??= (async () => {
        signal.removeEventListener('abort', onAbort)
        await run.dispose()
        this.runs.delete(owned)
      })().catch((error: unknown) => { disposal = undefined; throw error })
      return disposal
    }
    const onAbort = (): void => {
      if (disposal !== undefined) return
      void dispose().catch((error: unknown) => { this.ctx.logger.warn('SDK subagent process cleanup failed: %o', error) })
    }
    const owned: SubagentRun = { ...run, dispose }
    this.runs.add(owned)
    signal.addEventListener('abort', onAbort, { once: true })
    void run.result.then(onAbort)
    return owned
  }
}
