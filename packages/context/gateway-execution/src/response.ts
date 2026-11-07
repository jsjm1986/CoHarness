/** Unused Gateway response data cannot delay authorization denial or revocation. */

/**
 * Request stream cancellation without awaiting its acknowledgement or replacing the permission outcome.
 * @param source - unused response body or its acquired reader; null means no body.
 */
export function discardGatewayRead(source: { cancel(): Promise<void> } | null): void {
  if (source === null) return
  try {
    void source.cancel().catch(() => { /* cancellation rejection cannot replace the authorization outcome */ })
  } catch {
    // A cancellation throw cannot postpone denial or revocation.
  }
}
