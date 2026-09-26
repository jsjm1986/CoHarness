/** A physical stream failure that can be retried without repeating a business mutation. */
export class RemoteStreamCarrierError extends Error {
  /**
   * @param message - transport failure description.
   * @param options - optional underlying cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteStreamCarrierError'
  }
}
