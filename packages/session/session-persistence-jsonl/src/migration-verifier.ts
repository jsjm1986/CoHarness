/** Isolated verification for a staged or competing current JSONL generation. */

import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import { symbols } from '@deepseek-ai/cordis'
import { ResourceAdmissionError, type ResourceBudget, type ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import type { JsonlCompression } from './format.ts'
import type { JsonlExpectedPrefix, JsonlVerifiedGeneration } from './generation.ts'

interface VerificationRequest {
  readonly path: string
  readonly compression: JsonlCompression
  readonly expectedId: string
  readonly expectedEventCount: number
  readonly expectedPrefix?: JsonlExpectedPrefix
  readonly expectedVersion?: number
}

type VerificationResponse =
  | { readonly ok: true; readonly result: JsonlVerifiedGeneration }
  | { readonly ok: false; readonly message: string; readonly stack?: string }

function isVerificationResponse(value: unknown): value is VerificationResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (response.ok === false) return typeof response.message === 'string' && (response.stack === undefined || typeof response.stack === 'string')
  if (response.ok !== true || typeof response.result !== 'object' || response.result === null) return false
  const result = response.result as Record<string, unknown>
  if (!Number.isSafeInteger(result.bytes) || (result.bytes as number) < 0
    || typeof result.digest !== 'string' || !/^[0-9a-f]{64}$/.test(result.digest)
    || typeof result.identity !== 'object' || result.identity === null) return false
  const identity = result.identity as Record<string, unknown>
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => typeof identity[key] === 'bigint')
    && (identity.size as bigint) >= 0n
}

/** Explicit provider-local limits for verification isolates and their waiting requests. */
export interface JsonlVerificationLimits {
  readonly concurrency: number
  readonly maxQueued: number
}

/** Provider-owned admission lookup and late-cleanup diagnostics. */
export interface JsonlVerificationResources {
  /**
   * @returns the live provider retained before queueing and checked before Worker creation; absent only for independent compositions.
   */
  budget(): Pick<ResourceBudget, 'acquire'> | undefined
  /** @param error - failed late accounting after the caller already received its verification failure. */
  report(error: unknown): void
}

class VerificationCleanupError extends ResourceAdmissionError {
  constructor(cause: unknown, readonly stopped: Promise<void>) {
    super('unavailable', cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

/** Verification queue whose lifetime belongs to one persistence provider. */
export class JsonlMigrationVerifier {
  private active = 0
  private readonly waiting: Array<{ grant(): void }> = []
  private readonly pending = new Set<Promise<unknown>>()
  private closed = false

  /**
   * @param limits - validated concurrency and queue limits owned by the provider config.
   * @param resources - current budget lookup and diagnostics retained by this owner.
   */
  constructor(private readonly limits: JsonlVerificationLimits, private readonly resources: JsonlVerificationResources) {}

  /**
   * Verify one current generation in a fresh Worker Thread.
   * @param path - staged or competing current-generation path.
   * @param compression - configured physical encoding.
   * @param expectedId - Session id expected in the decoded header.
   * @param expectedEventCount - exact logical event count expected after decoding.
   * @param expectedPrefix - verified physical prefix; an append tail may be present and is not validated.
   * @param signal - optional cancellation for scheduler wait and Worker execution.
   * @param expectedVersion - format version the file must declare; defaults to the catalog's current version.
   * @returns stable physical identity and digest observed by the Worker.
   */
  verify(path: string, compression: JsonlCompression, expectedId: string, expectedEventCount: number,
    expectedPrefix?: JsonlExpectedPrefix, signal?: AbortSignal, expectedVersion?: number): Promise<JsonlVerifiedGeneration> {
    if (this.closed) return Promise.reject(new ResourceAdmissionError('unavailable', 'migration verifier is closed'))
    const task = this.run(owner => runVerificationWorker(
      path, compression, expectedId, expectedEventCount, expectedPrefix, owner, expectedVersion,
    ), signal)
    this.pending.add(task)
    const complete = (): void => { this.pending.delete(task) }
    void task.then(complete, complete)
    return task
  }

  /**
   * Close admission and drain accepted verification and termination work.
   * @returns completion after all accepted verifications, including queued work, settle.
   */
  async dispose(): Promise<void> {
    this.closed = true
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  private async run<T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const budget = this.resources.budget()
    const original = (value: Pick<ResourceBudget, 'acquire'> | undefined): Pick<ResourceBudget, 'acquire'> | undefined =>
      (value as (Pick<ResourceBudget, 'acquire'> & { [symbols.original]?: Pick<ResourceBudget, 'acquire'> }) | undefined)?.[symbols.original] ?? value
    const assertOwner = (): void => {
      if (original(this.resources.budget()) !== original(budget)) {
        throw new ResourceAdmissionError('unavailable', 'Migration verification resource owner changed; retry with its current provider.')
      }
    }
    const permit = this.acquire(signal)
    if (permit !== undefined) await permit
    let lease: ResourceLease | undefined
    const slot = { retained: false }
    try {
      signal?.throwIfAborted()
      assertOwner()
      if (budget !== undefined) {
        try { lease = await budget.acquire({ kind: 'process', ...(signal === undefined ? {} : { signal }), origin: 'infrastructure' }) } catch (error) {
          if (signal?.aborted === true) throw verifierAbortError(signal)
          throw error instanceof ResourceAdmissionError ? error
            : new ResourceAdmissionError('unavailable', 'migration verification resource admission failed', { cause: error })
        }
      }
      const owner = lease === undefined ? signal : AbortSignal.any([lease.signal, ...(signal === undefined ? [] : [signal])])
      owner?.throwIfAborted()
      assertOwner()
      let value: T
      try { value = await operation(owner) } catch (error) {
        if (error instanceof VerificationCleanupError) {
          slot.retained = true
          const held = lease
          lease = undefined
          const uncertain = held?.uncertain() ?? Promise.resolve()
          const stopped = error.stopped.then(async () => {
            try {
              try { await uncertain } catch {
                // The caller receives this uncertain-report failure; quiescence retries the reservation.
              }
              await held?.release()
            } finally { this.release() }
          })
          this.pending.add(stopped)
          void stopped.then(() => { this.pending.delete(stopped) }, (failure: unknown) => {
            this.pending.delete(stopped)
            this.resources.report(failure)
          })
          try { await uncertain } catch (failure) {
            throw new ResourceAdmissionError('unavailable', 'migration verification and resource completion failed', {
              cause: new AggregateError([error, failure]),
            })
          }
        }
        throw error
      }
      const completed = lease
      lease = undefined
      try { await completed?.release() } catch (error) {
        throw new ResourceAdmissionError('unavailable', 'migration verification resource completion failed', { cause: error })
      }
      return value
    } catch (error) {
      if (lease !== undefined) {
        try { await lease.release() } catch (failure) {
          throw new ResourceAdmissionError('unavailable', 'migration verification and resource completion failed', {
            cause: new AggregateError([error, failure]),
          })
        }
      }
      throw error
    } finally {
      if (!slot.retained) this.release()
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> | undefined {
    signal?.throwIfAborted()
    if (this.active < this.limits.concurrency) {
      this.active += 1
      return
    }
    if (this.waiting.length >= this.limits.maxQueued) {
      return Promise.reject(new ResourceAdmissionError('refused', 'migration verification queue is full'))
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: (): void => {
          signal?.removeEventListener('abort', abort)
          resolve()
        },
      }
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter)
        this.waiting.splice(index, 1)
        reject(verifierAbortError(signal))
      }
      this.waiting.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active -= 1
      return
    }
    next.grant()
  }
}

function workerSpawn(request: VerificationRequest): { readonly entry: string | URL; readonly options: WorkerOptions } {
  /* v8 ignore next 3 -- built-worker coverage owns the bundled path. */
  if (!import.meta.url.endsWith('.ts')) {
    return {
      entry: new URL('./worker.cjs', import.meta.url),
      options: { workerData: request, execArgv: [] },
    }
  }
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: request,
      execArgv: [],
    },
  }
}

function runVerificationWorker(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  expectedPrefix?: JsonlExpectedPrefix,
  signal?: AbortSignal,
  expectedVersion?: number,
): Promise<JsonlVerifiedGeneration> {
  signal?.throwIfAborted()
  const request: VerificationRequest = {
    path, compression, expectedId, expectedEventCount,
    ...(expectedPrefix === undefined ? {} : { expectedPrefix }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  }
  const { entry, options } = workerSpawn(request)
  let worker: Worker
  try { worker = new Worker(entry, options) } catch (error) {
    throw new VerificationCleanupError(error, new Promise<void>(() => {}))
  }
  let confirmStopped!: () => void
  const stopped = new Promise<void>((resolve) => { confirmStopped = resolve })
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      /* v8 ignore next -- a late error/exit races only after another terminal callback settled. */
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate().then(
        () => { confirmStopped(); reject(error) },
        (cleanup: unknown) => {
          reject(new VerificationCleanupError(new AggregateError([error, cleanup], 'migration verifier termination failed'), stopped))
        },
      )
    }
    worker.once('message', (value: unknown) => {
      /* v8 ignore next -- a duplicate message races only after another terminal callback settled. */
      if (settled) return
      if (!isVerificationResponse(value)) {
        fail(new ResourceAdmissionError('unavailable', 'migration verifier returned an invalid response'))
        return
      }
      const response = value
      if (!response.ok) {
        const error = new Error(response.message)
        if (response.stack !== undefined) error.stack = response.stack
        fail(error)
        return
      }
      settled = true
      cleanup()
      void worker.terminate().then(
        () => { confirmStopped(); resolve(response.result) },
        (error: unknown) => { reject(new VerificationCleanupError(error, stopped)) },
      )
    })
    worker.once('error', (error) => {
      fail(new ResourceAdmissionError('unavailable', `migration verifier Worker failed: ${error.message}`, { cause: error }))
    })
    worker.once('exit', (code) => {
      confirmStopped()
      if (!settled) fail(new ResourceAdmissionError('unavailable', `migration verifier exited before reporting a result (code ${code})`))
    })
    const abort = (): void => { fail(verifierAbortError(signal)) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function verifierAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error
    ? reason
    : new Error('migration verifier aborted', { cause: reason })
}
