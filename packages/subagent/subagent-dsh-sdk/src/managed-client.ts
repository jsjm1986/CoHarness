/** Child-side bounded HTTP transport and monotonic registration ordering. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { controlId, controlJson, controlRecord, type SdkControlConnection, type SdkControlId } from './control.ts'

/** Decode a Fetch body while cancelling unread bytes on every exit. */
async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (response.body === null) return
  const reader = response.body.getReader()
  try {
    for (;;) { const item = await reader.read(); if (item.done) return; yield item.value }
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

/** One private parent connection, closed only after model and process cleanup reports. */
export class ParentControlClient {
  private sequence = 0
  private registration: Promise<void> = Promise.resolve()
  private settledRegistration: SdkControlId | undefined
  private readonly closed = new AbortController()
  private readonly cleanups = new AsyncLocalStorage<{ deadline: number; signal: AbortSignal }>()
  private readonly modelCompletions = new Map<SdkControlId, { work?: Promise<void> }>()

  /** @param connection - validated per-run capability and deployment limits. */
  constructor(readonly connection: SdkControlConnection) {}

  /**
   * Register in id order without serializing model execution or resource waiting.
   * @param path - model/open or resource/register.
   * @param body - operation metadata.
   * @param signal - caller cancellation.
   * @returns the identity immediately plus registration acknowledgement.
   */
  register(path: string, body: Record<string, unknown>, signal?: AbortSignal): { id: SdkControlId; ready: Promise<void> } {
    const id = controlId(String(++this.sequence))
    const ready = this.registration.then(async () => { await this.post(path, { ...body, id }, signal) })
    const settled = (): void => { this.settledRegistration = id }
    this.registration = ready.then(settled, settled)
    return { id, ready }
  }

  /**
   * Retain model completion until its original parent span acknowledges closure.
   * @param id - original model registration.
   * @returns the shared pending acknowledgement; rejection preserves an exact retry.
   */
  closeModel(id: SdkControlId): Promise<void> {
    let completion = this.modelCompletions.get(id)
    if (completion === undefined) { completion = {}; this.modelCompletions.set(id, completion) }
    const owned = completion
    owned.work ??= this.post('/model/close', { id }).then(() => {
      this.modelCompletions.delete(id)
    }).catch((error: unknown) => { delete owned.work; throw error })
    return owned.work
  }

  /**
   * Recover retained model closures before further admission or final shutdown.
   * @returns after every retained span acknowledges closure; failed records remain owned.
   */
  async retryModelCompletions(): Promise<void> {
    const results = await Promise.allSettled([...this.modelCompletions.keys()].map(id => this.closeModel(id)))
    const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK model completion reporting failed.')
  }

  /**
   * Join shutdown under one deadline, including nested model and resource cleanup.
   * @param work - cleanup receiving the absolute monotonic deadline; a later retry gets a new deadline.
   * @returns the joined result, or rejected cleanup with unconfirmed operations retained by their owners.
   */
  async cleanup<T>(work: (deadline: number) => Promise<T>): Promise<T> {
    this.closed.signal.throwIfAborted()
    const current = this.cleanups.getStore()
    if (current !== undefined) {
      current.signal.throwIfAborted()
      return work(current.deadline)
    }
    const controller = new AbortController()
    const deadline = performance.now() + this.connection.config.cleanupTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const failure = new AggregateError([new ResourceAdmissionError('unavailable', 'SDK child cleanup deadline expired.')],
          'SDK child cleanup did not settle.')
        controller.abort(failure)
        reject(failure)
      }, this.connection.config.cleanupTimeoutMs)
    })
    try { return await this.cleanups.run({ deadline, signal: controller.signal }, () => Promise.race([work(deadline), timeout])) }
    finally { clearTimeout(timer) }
  }

  /**
   * Exchange one bounded authenticated request; client closure aborts its fetch and body read.
   * @param path - private method.
   * @param body - JSON parameters.
   * @param caller - optional request cancellation.
   * @returns bounded response fields.
   */
  async post(path: string, body: Record<string, unknown>, caller?: AbortSignal): Promise<Record<string, unknown>> {
    const completion = path === '/model/close' || path === '/resource/finish'
    const data = JSON.stringify({ ...body, ...completion && this.settledRegistration !== undefined
      ? { settledRegistration: this.settledRegistration } : {} })
    if (Buffer.byteLength(data) > this.connection.config.maxBytes) throw new ResourceAdmissionError('refused', 'SDK control request exceeds its byte limit.')
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new ResourceAdmissionError('unavailable', 'SDK parent control timed out.')) },
      this.connection.config.requestTimeoutMs)
    const cleanup = this.cleanups.getStore()
    const signal = AbortSignal.any([this.closed.signal, timeout.signal, ...caller === undefined ? [] : [caller],
      ...cleanup === undefined ? [] : [cleanup.signal]])
    try {
      signal.throwIfAborted()
      const response = await fetch(new URL(path, this.connection.url), { method: 'POST',
        headers: { authorization: `Bearer ${this.connection.token}`, 'content-type': 'application/json' }, body: data, signal })
      const result = controlRecord(await controlJson(responseChunks(response), this.connection.config.maxBytes))
      if (response.ok) return result
      const error = controlRecord(result.error)
      const message = typeof error.message === 'string' ? error.message : 'SDK parent control rejected the request.'
      if (['unavailable', 'cancelled', 'expired', 'refused'].includes(String(error.code))) {
        throw new ResourceAdmissionError(error.code as 'unavailable' | 'cancelled' | 'expired' | 'refused', message)
      }
      throw new LlmError(message, typeof error.code === 'string' ? error.code : 'SDK_PARENT_CONTROL_ERROR')
    } finally { clearTimeout(timer) }
  }

  /** Stop new traffic after the owning model and resource cleanup has settled. */
  close(): void {
    this.closed.abort(new ResourceAdmissionError('cancelled', 'SDK parent connection was closed.'))
    this.cleanups.disable()
  }
}
