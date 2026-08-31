/** Instance-owned concurrency bound for native image transformations. */

interface WaitingTask {
  readonly start: () => void
  cancelled: boolean
}

/** FIFO limiter for asynchronous compression work. */
export class CompressionLimiter {
  private active = 0
  private readonly waiting: WaitingTask[] = []
  private waitingHead = 0

  /**
   * @param concurrency - positive maximum number of active tasks.
   */
  constructor(readonly concurrency: number) {}

  /**
   * Run one task after an instance slot becomes available.
   * @param task - compression operation occupying one slot until settlement.
   * @param options - optional cancellation signal for a queued task.
   * @returns the task result.
   */
  run<T>(task: () => Promise<T>, options: { readonly signal?: AbortSignal } = {}): Promise<T> {
    options.signal?.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      let started = false
      let settled = false
      const signal = options.signal
      const onAbort = (): void => {
        /* v8 ignore next -- the once listener is removed after the first abort. */
        if (started || settled) return
        settled = true
        entry.cancelled = true
        signal?.removeEventListener('abort', onAbort)
        reject(signalError(signal))
      }
      const start = (): void => {
        /* v8 ignore next -- cancelled waiters are skipped by release before start is called. */
        if (entry.cancelled) return
        started = true
        signal?.removeEventListener('abort', onAbort)
        this.active += 1
        const release = (): void => {
          this.active -= 1
          while (this.waitingHead < this.waiting.length) {
            const next = this.waiting[this.waitingHead++]
            if (next?.cancelled !== false) continue
            next.start()
            break
          }
          if (this.waitingHead >= 64 && this.waitingHead * 2 >= this.waiting.length) {
            this.waiting.splice(0, this.waitingHead)
            this.waitingHead = 0
          }
        }
        void Promise.resolve().then(task).then(
          (value) => {
            release()
            /* v8 ignore next -- a queued task is never started after cancellation. */
            if (!settled) {
              settled = true
              resolve(value)
            }
          },
          (error: unknown) => {
            release()
            /* v8 ignore next -- a queued task is never started after cancellation. */
            if (!settled) {
              settled = true
              reject(error instanceof Error
                ? error
                : new Error('Image compression task rejected with a non-Error value.', { cause: error }))
            }
          },
        )
      }
      const entry: WaitingTask = {
        start,
        cancelled: false,
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      if (this.active < this.concurrency) start()
      else this.waiting.push(entry)
    })
  }
}

function signalError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error
    ? reason
    : new Error('Image compression task cancelled.', { cause: reason })
}
