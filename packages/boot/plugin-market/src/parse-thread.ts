/** Runs index parsing in a fresh Worker Thread, so a large index does not block the Host event loop. */
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import type { IndexParseRequest, IndexParseResult } from './parse.ts'

class UnconfirmedWorkerError extends Error {
  constructor(message: string, cause: unknown, readonly exited?: Promise<void>) { super(message, { cause }) }
}

function workerSpawn(): { readonly entry: URL; readonly options: WorkerOptions } {
  /* v8 ignore next -- built-artifact runs own the bundled path. */
  if (!import.meta.url.endsWith('.ts')) return { entry: new URL('./worker.cjs', import.meta.url), options: { execArgv: [] } }
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(new URL('./worker.ts', import.meta.url).href)})`,
  ].join('\n')
  return { entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), options: { execArgv: [] } }
}

/** Whether a Worker message is a parse result: an index object, or a violation's path, reason, and message. */
function isResult(value: unknown): value is IndexParseResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return result.ok === true
    ? typeof result.index === 'object' && result.index !== null
    : result.ok === false && [result.path, result.reason, result.message].every(field => typeof field === 'string')
}

/**
 * Run `parseIndexBody` in a fresh Worker Thread. The body's buffer is transferred to the Worker and is unusable
 * afterwards; the result is copied back by structured clone.
 * @param body - the complete response body; it must own its whole buffer.
 * @param url - the index URL.
 * @param signal - terminates the Worker and rejects with the signal's reason.
 * @param budget - optional process admission, retained through confirmed Worker termination.
 * @param assertOwnership - optional caller-owned check of the retained provider immediately before Worker creation.
 * @returns the Worker's result.
 * @throws the abort reason, or an Error when the Worker fails, exits without a result, or reports an unexpected value.
 */
export async function parseIndexInWorker(body: Uint8Array, url: string, signal: AbortSignal,
  budget?: Pick<ResourceBudget, 'acquire'>, assertOwnership?: () => void): Promise<IndexParseResult> {
  signal.throwIfAborted()
  if (budget === undefined) {
    assertOwnership?.()
    return runParser(body, url, signal)
  }
  const lease = await budget.acquire({ kind: 'process', signal, origin: 'infrastructure' })
  const owner = AbortSignal.any([signal, lease.signal])
  let outcome: { ok: true; value: IndexParseResult } | { ok: false; error: unknown }
  try {
    owner.throwIfAborted()
    assertOwnership?.()
    outcome = { ok: true, value: await runParser(body, url, owner) }
  } catch (error) { outcome = { ok: false, error } }
  const unconfirmed = !outcome.ok && outcome.error instanceof UnconfirmedWorkerError ? outcome.error : undefined
  try {
    if (unconfirmed === undefined) await lease.release()
    else await lease.uncertain()
  } catch (error) {
    throw outcome.ok ? error : new AggregateError([outcome.error, error], 'Index parsing and resource completion failed')
  } finally {
    if (unconfirmed?.exited !== undefined) {
      void unconfirmed.exited.then(() => lease.release()).catch((error: unknown) => {
        console.error('[plugin-market] index parser resource cleanup failed:', error)
      })
    }
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

function runParser(body: Uint8Array, url: string, signal: AbortSignal): Promise<IndexParseResult> {
  const { entry, options } = workerSpawn()
  const request: IndexParseRequest = { body, url }
  let worker: Worker
  try { worker = new Worker(entry, { ...options, workerData: request, transferList: [body.buffer as ArrayBuffer] }) } catch (error) {
    throw new UnconfirmedWorkerError('index parser allocation could not be confirmed', error)
  }
  let confirmExit!: () => void
  const exited = new Promise<void>((resolve) => { confirmExit = resolve })
  return new Promise((resolve, reject) => {
    let settled = false
    let stopped = false
    let cancelled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      void worker.terminate().then(() => {
        stopped = true
        confirmExit()
        signal.removeEventListener('abort', abort)
        finish()
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        if (cancelled) console.error('[plugin-market] index parser termination failed after cancellation:', error)
        reject(new UnconfirmedWorkerError('index parser termination could not be confirmed', error, exited))
      })
    }
    const abort = (): void => {
      cancelled = true
      settle(() => { reject(signal.reason as Error) })
      if (stopped) reject(signal.reason as Error)
      else {
        const message = signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
        reject(new UnconfirmedWorkerError(message, signal.reason, exited))
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (value: unknown) => {
      settle(() => { if (isResult(value)) resolve(value); else reject(new Error('index parser reported an unexpected value')) })
    })
    worker.once('error', (error) => { settle(() => { reject(error) }) })
    worker.once('exit', (code) => {
      stopped = true
      confirmExit()
      settle(() => { reject(new Error(`index parser exited before reporting a result (code ${String(code)})`)) })
    })
  })
}
