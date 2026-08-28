/** Instance-owned concurrency bound for native image transformations. */

/** FIFO limiter for asynchronous compression work. */
export class CompressionLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []
  private waitingHead = 0

  /**
   * @param concurrency - positive maximum number of active tasks.
   */
  constructor(readonly concurrency: number) {}

  /**
   * Run one task after an instance slot becomes available.
   * @param task - compression operation occupying one slot until settlement.
   * @returns the task result.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1
        const release = (): void => {
          this.active -= 1
          const next = this.waiting[this.waitingHead]
          if (next !== undefined) {
            this.waitingHead += 1
            next()
            if (this.waitingHead >= 64 && this.waitingHead * 2 >= this.waiting.length) {
              this.waiting.splice(0, this.waitingHead)
              this.waitingHead = 0
            }
          }
        }
        void Promise.resolve().then(task).then(
          (value) => {
            release()
            resolve(value)
          },
          (error: unknown) => {
            release()
            reject(error instanceof Error
              ? error
              : new Error('Image compression task rejected with a non-Error value.', { cause: error }))
          },
        )
      }
      if (this.active < this.concurrency) start()
      else this.waiting.push(start)
    })
  }
}
