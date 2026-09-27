/** Deterministic test synchronization without timer-based ordering. @module */

/**
 * Hold a test operation until its owner explicitly releases it.
 * @returns the completion promise and its idempotent release operation
 */
export function barrier(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}
