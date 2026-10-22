/**
 * Server-only request scope for the admitted Connection's interaction mode.
 * The Connection carrier binds the scope inside its `connection/request`
 * waterfall (the same propagation point Gateway Runtime uses for request
 * principals); API handlers read it synchronously. Unbound dispatch —
 * in-process callers and internal work — reports `'answer'`, the historical
 * full-participation behavior.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ConnectionInteractions } from './interactions.ts'

interface RequestScope {
  readonly interactions: ConnectionInteractions
}

const scopeStorage = new AsyncLocalStorage<RequestScope>()

/**
 * Bind one request's interaction mode for the duration of its dispatch.
 * @param scope - the admitted connection's interaction mode.
 * @param next - the downstream dispatch (must be invoked to continue).
 * @returns the next callback's completion.
 */
export function bindRequestInteractions(
  scope: ConnectionInteractions,
  next: () => Promise<void>,
): Promise<void> {
  return scopeStorage.run({ interactions: scope }, next)
}

/**
 * Read the interaction mode bound to the current request dispatch.
 * @returns the bound mode, or `'answer'` outside a bound request — the
 *   full-participation behavior every pre-scope caller had.
 */
export function requestInteractions(): ConnectionInteractions {
  return scopeStorage.getStore()?.interactions ?? 'answer'
}
