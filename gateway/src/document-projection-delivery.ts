/** Per-root ordering and shutdown ownership for document catalog delivery. */
import { DOCUMENT_STORE_UNAVAILABLE_CODE, UserDocError } from '@deepseek-ai/dsh-userdoc'

/** Keeps each receiver cursor read, journal read, commit and acknowledgement in one delivery. */
export class DocumentProjectionDelivery {
  private tail = Promise.resolve()
  private closed = false

  /**
   * Admit one independently authorized delivery after this root's earlier deliveries settle.
   * @param operation - complete delivery, including its pending-journal check.
   * @returns this delivery's result; a failed predecessor does not replace its authority or result.
   */
  run(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new UserDocError('The document service is stopping.', DOCUMENT_STORE_UNAVAILABLE_CODE))
    const pending = this.tail.then(operation)
    this.tail = pending.catch(() => {
      // The caller owns the failure; later deliveries retry from the durable receiver cursor.
    })
    return pending
  }

  /**
   * Refuse new deliveries while retaining the root until accepted deliveries settle.
   * @returns after all accepted deliveries settle; individual failures belong to their callers.
   */
  close(): Promise<void> {
    this.closed = true
    return this.tail
  }
}
