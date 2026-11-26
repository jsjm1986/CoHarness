/** Deterministic test synchronization without timer-based ordering. @module */

/**
 * Hold a test operation until its owner explicitly releases it.
 * @returns the completion promise and its idempotent release operation
 */
export function barrier(): { promise: Promise<void>; resolve(): void } {
  const { promise, resolve } = deferred<void>()
  return { promise, resolve }
}

/**
 * Deliver a fixture result or failure once its asynchronous operation arrives.
 * @returns the result promise and the callbacks that settle it
 */
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}
