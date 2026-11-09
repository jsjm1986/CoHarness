/** Failure containment and shutdown coordination for the Inspector Worker. */

import type { Worker } from 'node:worker_threads'
import type { ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import type { InspectorHostControl, InspectorWorkerControl } from '../../shared/bridge/messages/control.ts'
import { parseInspectorWorkerControl } from '../../shared/bridge/control-codec.ts'
import { diag } from '../../shared/diag.ts'

/** Tracks Worker termination without removing the listener that contains runtime errors. */
export class InspectorWorkerLifecycle {
  private readonly exitResolution = Promise.withResolvers<number>()
  private readonly failureResolution = Promise.withResolvers<Error>()
  private failure: Error | undefined
  private running = false
  private expectedExit = false
  private notified = false
  private onUnexpectedExit: ((error: Error) => void) | undefined
  private exitCodeValue: number | undefined
  private completion: Promise<void> | undefined

  /** Worker exit code once its `exit` event has fired. */
  get exitCode(): number | undefined {
    return this.exitCodeValue
  }

  constructor(private readonly worker: Worker, private readonly lease?: ResourceLease) {
    worker.on('error', (error) => {
      this.failure ??= error
      this.failureResolution.resolve(error)
      this.notifyUnexpectedExit()
    })
    worker.once('exit', (code) => {
      this.exitCodeValue = code
      this.exitResolution.resolve(code)
      this.notifyUnexpectedExit()
      void this.complete().catch((error: unknown) => {
        console.error('dsh inspector: Worker resource completion could not be confirmed', error)
      })
    })
  }

  /**
   * Wait for the validated ready frame while also observing startup failure and exit.
   * @param timeoutMs - Readiness deadline in milliseconds.
   * @param signal - Cancellation of startup, before the handle is published.
   * @returns The Worker's bound endpoint fields.
   */
  async waitForReady(timeoutMs: number, signal?: AbortSignal): Promise<Extract<InspectorWorkerControl, { type: 'ready' }>> {
    signal?.throwIfAborted()
    const ready = Promise.withResolvers<Extract<InspectorWorkerControl, { type: 'ready' }>>()
    const onMessage = (value: unknown): void => {
      let control: InspectorWorkerControl
      try { control = parseInspectorWorkerControl(value) } catch (error) { ready.reject(error); return }
      if (control.type === 'ready') ready.resolve(control)
      else if (control.type === 'failure') ready.reject(new Error(`inspector Worker failed: ${control.message}`))
    }
    const onAbort = (event: Event): void => {
      const reason: unknown = (event.currentTarget as AbortSignal).reason
      ready.reject(reason instanceof Error ? reason : new Error('inspector: startup canceled', { cause: reason }))
    }
    const timer = setTimeout(() => {
      ready.reject(new Error(`inspector Worker did not become ready within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    this.worker.on('message', onMessage)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([
        ready.promise,
        this.failureResolution.promise.then((error) => { throw error }),
        this.exitResolution.promise.then((code) => {
          throw new Error(`inspector Worker exited before readiness (code ${String(code)})`)
        }),
      ])
    } finally {
      clearTimeout(timer)
      this.worker.off('message', onMessage)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Begin reporting an unexpected runtime exit through one contained callback.
   * @param listener - Failure observer that must not throw.
   */
  markRunning(listener: (error: Error) => void): void {
    this.running = true
    this.onUnexpectedExit = listener
    this.notifyUnexpectedExit()
  }

  /** Mark subsequent Worker termination as owner-requested. */
  expectExit(): void {
    this.expectedExit = true
  }

  /** Terminate the Worker during failed initialization. */
  async terminate(): Promise<void> {
    this.expectExit()
    if (this.exitCodeValue === undefined) {
      diag('lifecycle: terminate()')
      try { await this.worker.terminate() } catch (error) {
        diag('lifecycle: terminate() rejected')
        try { await this.lease?.uncertain() } catch (reportError) {
          throw new AggregateError([error, reportError], 'inspector: Worker termination and uncertainty report failed')
        }
        throw error
      }
    }
    diag('lifecycle: terminate() settled')
    await this.complete()
  }

  /**
   * Request graceful shutdown and terminate after the deadline.
   * @param timeoutMs - Grace period before forced termination.
   */
  async stop(timeoutMs: number): Promise<void> {
    this.expectExit()
    if (this.exitCodeValue !== undefined) return this.complete()
    this.worker.postMessage({ type: 'shutdown' } satisfies InspectorHostControl)
    diag('lifecycle: shutdown posted')
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { resolve('timeout') }, timeoutMs)
    })
    const outcome = await Promise.race([
      this.exitResolution.promise.then(() => 'exited' as const),
      timeout,
    ])
    clearTimeout(timer)
    diag(`lifecycle: stop outcome=${outcome}`)
    if (outcome === 'exited') return this.complete()
    await this.terminate()
    throw new Error(`inspector Worker did not stop within ${String(timeoutMs)}ms and was terminated`)
  }

  private complete(): Promise<void> {
    return this.completion ??= Promise.resolve().then(() => this.lease?.release()).catch((error: unknown) => {
      this.completion = undefined
      throw error
    })
  }

  private notifyUnexpectedExit(): void {
    if (!this.running || this.expectedExit || this.notified || this.exitCodeValue === undefined) return
    this.notified = true
    this.onUnexpectedExit?.(this.failure ?? new Error(
      `inspector Worker exited unexpectedly with code ${String(this.exitCodeValue)}`,
    ))
  }
}
