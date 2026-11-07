/** Fixed metadata for a downlink ending; remote reason text never crosses this diagnostic path. */

/** Browser-supplied close fields that contain no application text. */
export interface SocketClosure {
  readonly closeCode: number
  readonly wasClean: boolean
}

/** Package-internal completion marker, consumed by the existing connection failure channel. */
export class StreamTermination extends Error {
  /**
   * @param kind - a completed stream or a locally rejected retained burst.
   * @param closure - optional browser close code and clean-handshake flag.
   */
  constructor(readonly kind: 'stream-eof' | 'queue-overflow', readonly closure?: SocketClosure) {
    super('Connection downlink ended')
    this.name = 'StreamTermination'
  }
}
