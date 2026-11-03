/** Provider-native streaming operations without child-owned endpoints or credentials. */

/** Secret-free request retained by the Consumer before model dispatch. */
export interface NativeModelStreamRequest {
  /** Provider wire protocol; unsupported protocols fail during preparation. */
  readonly protocol: string
  /** Complete model-visible JSON body, resolved by the owning adapter. */
  readonly body: Readonly<Record<string, unknown>>
}

/** One complete provider event; framing and bounded parsing belong to the adapter. */
export interface NativeModelStreamEvent {
  /** Provider event name. */
  readonly event: string
  /** Original JSON data for this event. */
  readonly data: string
}

/** Transport observations accepted by a prepared native model operation. */
export interface NativeModelStreamParameters extends NativeModelStreamRequest {
  /** Maximum response bytes, including incomplete frames. */
  readonly maxResponseBytes: number
  /**
   * Deliver one event with backpressure; rejection cancels the provider body.
   * @param event - complete validated provider event.
   * @returns after the Consumer accepts the event.
   */
  readonly write: (event: NativeModelStreamEvent) => Promise<void>
}
