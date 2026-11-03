/** Failure text shared by job registries and archive cancellation. */

/**
 * Preserve a thrown value's normal text without letting coercion interrupt job cleanup.
 * @param value - rejected or thrown producer or observer failure.
 * @returns the value's text, or a fixed label when conversion fails.
 */
export function renderJobFailure(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[unrenderable thrown value]'
  }
}
