/** Single-item rendezvous used by the managed SDK model stream. */
interface Sender<T> { value: T; resolve(): void; reject(error: Error): void }
interface Reader<T> { resolve(value: IteratorResult<T>): void; reject(error: Error): void; detach(): void }

/** Bounded model relay; closing wakes both sides and rejects an unconsumed send. */
export class ModelChannel<T> {
  private sender: Sender<T> | undefined
  private reader: Reader<T> | undefined
  private closed = false
  private failure: Error | undefined

  /**
   * Wait until the single reader consumes this item; closure rejects undelivered sends.
   * @param value - one frame.
   * @returns acknowledgement that the consumer received it.
   */
  push(value: T): Promise<void> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('SDK model relay is closed.'))
    const reader = this.reader
    if (reader !== undefined) {
      this.reader = undefined
      reader.detach()
      reader.resolve({ done: false, value })
      return Promise.resolve()
    }
    if (this.sender !== undefined) return Promise.reject(new Error('Concurrent SDK model sends are unsupported.'))
    return new Promise((resolve, reject) => { this.sender = { value, resolve, reject } })
  }

  /**
   * Receive one item without cancelling the stream when this individual wait is aborted.
   * @param signal - cancel only this wait.
   * @returns the next frame or end of stream; a failed close rejects the read.
   */
  take(signal?: AbortSignal): Promise<IteratorResult<T>> {
    if (signal?.aborted === true) return Promise.reject(new Error('SDK model relay wait was cancelled.'))
    const sender = this.sender
    if (sender !== undefined) {
      this.sender = undefined
      sender.resolve()
      return Promise.resolve({ done: false, value: sender.value })
    }
    if (this.closed) return this.failure === undefined ? Promise.resolve({ done: true, value: undefined }) : Promise.reject(this.failure)
    if (this.reader !== undefined) return Promise.reject(new Error('Concurrent SDK model reads are unsupported.'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.reader = undefined
        reader.detach()
        reject(new Error('SDK model relay wait was cancelled.'))
      }
      const reader: Reader<T> = { resolve, reject, detach: () => { signal?.removeEventListener('abort', onAbort) } }
      this.reader = reader
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Wake both sides; pending sends never count as delivered.
   * @param error - optional terminal failure shared by pending readers and writers.
   */
  close(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    const sender = this.sender, reader = this.reader
    this.sender = undefined
    this.reader = undefined
    sender?.reject(error ?? new Error('SDK model relay is closed.'))
    reader?.detach()
    if (error === undefined) reader?.resolve({ done: true, value: undefined })
    else reader?.reject(error)
  }
}
