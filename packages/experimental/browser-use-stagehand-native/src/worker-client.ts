/** Isolated Stagehand Workers own CDP connections; the host owns browser processes. */

import { Worker } from 'node:worker_threads'
import { AsyncLocalStorage } from 'node:async_hooks'
import type ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ResourceAcquisitionCleanupError } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import { StagehandDrainError } from './native.ts'
import type { NativeBrowserConfig, NativeBrowserRuntime } from './native.ts'
import { answer, request } from './worker-rpc.ts'
import type { StagehandModelHandler } from './model.ts'

/** Captured Session and node accountant for a managed attachment Worker. */
export interface BrowserWorkerAdmission {
  /** Captured accountant; undefined permits independent allocation under the ownership guard. */
  readonly budget: Pick<ResourceBudget, 'acquire'> | undefined
  readonly sessionId: SessionId
  /** Verify the retained provider before allocation and publication; omission retains the supplied accountant. */
  readonly assertOwnership?: () => void
}

/**
 * Connect Stagehand through an isolated Worker that receives no ambient environment.
 * @param config - resolved CDP connection and operation options.
 * @param signal - cancellation of lazy browser acquisition.
 * @param warn - report SDK cleanup failures after connection termination.
 * @param model - host inference owner; invoked in the current operation's async context.
 * @param admission - captured Session admission and ownership guard; omission permits independent allocation.
 * @returns a runtime whose close requires SDK request drainage before releasing ownership.
 * @throws ResourceAcquisitionCleanupError when allocation or initialization retains Worker or accounting cleanup.
 */
export async function openBrowserWorker(
  config: NativeBrowserConfig, signal: AbortSignal, warn: (message: string) => void,
  model: StagehandModelHandler,
  admission?: BrowserWorkerAdmission,
): Promise<NativeBrowserRuntime> {
  signal.throwIfAborted()
  admission?.assertOwnership?.()
  signal.throwIfAborted()
  const lease = await admission?.budget?.acquire({ kind: 'process', sessionId: admission.sessionId, signal })
  const openingSignal = lease === undefined ? signal : AbortSignal.any([signal, lease.signal])
  let released: Promise<void> | undefined
  const release = (): Promise<void> => released ??= Promise.resolve().then(async () => { await lease?.release() })
    .catch((error: unknown) => { released = undefined; throw error })
  try {
    openingSignal.throwIfAborted()
    admission?.assertOwnership?.()
    openingSignal.throwIfAborted()
  } catch (error) {
    try { await release() } catch (cleanupError) {
      throw new ResourceAcquisitionCleanupError(release,
        new AggregateError([error, cleanupError], 'Stagehand Worker admission cleanup failed'))
    }
    throw error
  }
  const entry = new URL('./worker.js', import.meta.url)
  // Worker data contains a non-secret route; inference credentials stay in the host provider.
  const env: NodeJS.ProcessEnv = {}
  if (process.env.TSX_TSCONFIG_PATH !== undefined) env.TSX_TSCONFIG_PATH = process.env.TSX_TSCONFIG_PATH
  let worker: Worker
  try {
    /* v8 ignore next 3 -- native.e2e.ts starts the bundled Worker through a plain-Node provider fixture. */
    if (!import.meta.url.endsWith('.ts')) {
      worker = new Worker(entry, { workerData: config, execArgv: [], env })
    } else {
      const source = new URL('./worker.ts', import.meta.url)
      const bootstrap = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(source.href)})`
      worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { workerData: config, execArgv: [], env })
    }
  } catch (error) {
    let reporting: Promise<void> | undefined
    const report = (): Promise<void> => reporting ??= Promise.resolve().then(async () => { await lease?.uncertain() })
      .catch((failure: unknown) => { reporting = undefined; throw failure })
    try { await report() } catch (cleanupError) {
      throw new ResourceAcquisitionCleanupError(report,
        new AggregateError([error, cleanupError], 'Stagehand Worker allocation and resource accounting failed'))
    }
    throw error
  }
  let stopped = false
  let termination: Promise<void> | undefined
  const terminate = (): Promise<void> => termination ??= (async () => {
    if (!stopped) {
      try { await worker.terminate(); stopped = true } catch (error) {
        await lease?.uncertain()
        throw error
      }
    }
    await release()
  })().catch((error: unknown) => { termination = undefined; throw error })
  const lifetime = new AbortController()
  let operation: {
    stop: AbortController
    signal: AbortSignal
    run: ReturnType<typeof AsyncLocalStorage.snapshot>
  } | undefined
  const modelRequests = new Set<Promise<void>>()
  worker.on('message', (raw: unknown) => {
    // Reply-bearing messages are RPC requests; other Worker notifications grant no capability.
    if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, 'reply')) return
    const owner = operation
    const pending = answer(raw, async (method, args) => {
      if (method !== 'model' || owner === undefined || drainage !== undefined) {
        throw new Error('Stagehand model requests require an active browser operation')
      }
      owner.signal.throwIfAborted()
      return owner.run(() => model(args, owner.signal))
    })
    modelRequests.add(pending)
    void pending.then(() => { modelRequests.delete(pending) }, (error: unknown) => {
      modelRequests.delete(pending)
      lifetime.abort(error)
      warn('Stagehand Worker model protocol failed; its connection is closing.')
      void close().catch(() => { warn('Stagehand Worker protocol cleanup failed.') })
    })
  })
  worker.once('error', (error) => { lifetime.abort(error) })
  worker.once('exit', (code) => {
    stopped = true
    lifetime.abort(new Error(`Stagehand browser Worker exited (${code})`))
    void release().catch(() => { warn('Stagehand Worker resource completion could not be confirmed.') })
  })
  let drainage: Promise<void> | undefined
  const drain = (): Promise<void> => drainage ??= (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        request(worker, 'close', undefined, lifetime.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error('Stagehand connection cleanup timed out')) }, config.shutdownGraceMs)
        }),
      ])
    } catch (error) {
      warn(`Stagehand SDK cleanup did not finish: ${String(error)}`)
      throw new StagehandDrainError(`Stagehand SDK requests did not drain: ${String(error)}`, { cause: error })
    } finally {
      clearTimeout(timeout)
    }
  })()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
    operation?.stop.abort(new Error('Stagehand browser connection is closing'))
    try { await drain() } finally {
      try { await terminate() } finally {
        await Promise.allSettled(modelRequests)
        lease?.signal.removeEventListener('abort', cancelAdmission)
        if (stopped) worker.removeAllListeners()
      }
    }
  }).catch((error: unknown) => { closing = undefined; throw error })
  const cancelAdmission = (): void => {
    lifetime.abort(lease?.signal.reason)
    void close().catch(() => { warn('Stagehand Worker cancellation cleanup failed.') })
  }
  lease?.signal.addEventListener('abort', cancelAdmission, { once: true })
  const abortOpening = () => { void terminate().catch((error: unknown) => { lifetime.abort(error) }) }
  openingSignal.addEventListener('abort', abortOpening, { once: true })
  try {
    await request(worker, 'ready', undefined, lifetime.signal)
    openingSignal.throwIfAborted()
    admission?.assertOwnership?.()
    openingSignal.throwIfAborted()
    lifetime.signal.throwIfAborted()
  } catch (error) {
    const failure: unknown = lifetime.signal.reason ?? error
    try { await terminate() } catch (cleanupError) {
      throw new ResourceAcquisitionCleanupError(async () => {
        if (stopped) await release()
        else await terminate()
      }, new AggregateError([failure, cleanupError], 'Stagehand Worker initialization and cleanup failed'))
    } finally { lease?.signal.removeEventListener('abort', cancelAdmission) }
    openingSignal.throwIfAborted()
    throw failure
  } finally {
    openingSignal.removeEventListener('abort', abortOpening)
  }
  return {
    async execute(method, args, signal) {
      signal?.throwIfAborted()
      lifetime.signal.throwIfAborted()
      if (closing !== undefined || drainage !== undefined) throw new Error('Stagehand browser Worker is closed')
      if (operation !== undefined) throw new Error('Stagehand browser Worker already has an active operation')
      const stop = new AbortController()
      const activeSignal = AbortSignal.any([lifetime.signal, stop.signal, ...signal === undefined ? [] : [signal]])
      operation = { stop, signal: activeSignal, run: AsyncLocalStorage.snapshot() }
      const timeout = setTimeout(() => { stop.abort(new Error('Stagehand browser operation timed out')) }, config.operationTimeoutMs)
      const canceled = () => { void close().catch((error: unknown) => { lifetime.abort(error) }) }
      activeSignal.addEventListener('abort', canceled, { once: true })
      try {
        const result = await request(worker, method, args, lifetime.signal)
        activeSignal.throwIfAborted()
        return result
      } catch (error) {
        activeSignal.throwIfAborted()
        throw error
      } finally {
        clearTimeout(timeout)
        activeSignal.removeEventListener('abort', canceled)
        stop.abort(new Error('Stagehand browser operation finished'))
        await Promise.allSettled(modelRequests)
        operation = undefined
      }
    },
    close,
  }
}
