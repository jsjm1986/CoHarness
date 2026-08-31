/**
 * Identify persistence/authorization internals that must not reach user copy.
 * @param message - Failure text produced by a runtime or persistence layer.
 * @returns true when the text names an internal session-persistence failure.
 */
export function isSessionPersistenceFailureMessage(message: string): boolean {
  return /session persistence|conversation (?:creator|contributor) .*rw project member|session could not be saved/iu.test(message)
}

/**
 * Convert a durable failure into copy that is safe to expose in the GUI.
 * @param failure - Failure value preserved by the session event.
 * @returns Display-safe copy for client projections.
 */
export function displayFailureMessage(failure: unknown): string {
  if (failure === null || typeof failure !== 'object') return String(failure)
  const record = failure as { code?: unknown; message?: unknown }
  // Provider AUTH messages may echo a masked or partially preserved credential.
  // Keep the raw diagnostic in the session log, but never project it into UI state.
  if (record.code === 'AUTH') return 'API key is invalid'
  const message = typeof record.message === 'string' ? record.message : JSON.stringify(failure)
  return isSessionPersistenceFailureMessage(message)
    ? 'Session could not be saved. Please try again.'
    : message
}
