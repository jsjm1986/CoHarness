/** Archive HTTP refusal releases unused data without replacing the synchronization error. */

/**
 * Require a successful archive response and cancel unused refusal data.
 * @param response - private Gateway response whose body has not been acquired.
 * @param operation - archive operation's failure description.
 * @throws the HTTP status error when the Gateway refuses the operation.
 */
export function requireArchiveResponse(response: Response, operation: string): void {
  if (response.ok) return
  void response.body?.cancel().catch((_cancellationFailure: unknown) => {
    // The HTTP refusal remains primary; the request signal owns transport shutdown.
  })
  throw new Error(`${operation} with HTTP ${String(response.status)}`)
}
