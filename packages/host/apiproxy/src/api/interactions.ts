/**
 * Interaction-participation mode shared by the client Connection install, the
 * request wire declaration, and the Host request scope. Kept dependency-free
 * so every compilation face (browser, Node, server) may import it.
 */

/** How a Connection participates in forwarded and answerable interactions. */
export type ConnectionInteractions = 'none' | 'answer'

/** HTTP header declaring the request's interaction participation. */
export const INTERACTIONS_HEADER = 'x-dsh-interactions'

/** URL query parameter declaring the same mode on carriers that cannot set headers. */
export const INTERACTIONS_QUERY = 'interactions'

/** URL query parameter carrying a launch token on carriers that cannot set Authorization. */
export const LAUNCH_TOKEN_QUERY = 'token'

const MODES: ReadonlySet<string> = new Set<ConnectionInteractions>(['none', 'answer'])

/**
 * Parse one declared mode strictly. Only the exact vocabulary is a
 * declaration; anything else (including an empty string) is reported as
 * malformed so the caller can refuse rather than silently downgrade.
 * @param value - raw header or query value, or undefined when undeclared.
 * @returns the declared mode, `'invalid'` for a malformed declaration, or
 *   undefined when no declaration is present.
 */
export function parseInteractions(value: string | undefined): ConnectionInteractions | 'invalid' | undefined {
  if (value === undefined) return undefined
  return MODES.has(value) ? value as ConnectionInteractions : 'invalid'
}

/**
 * Error thrown client-side when an interaction helper runs on a `'none'`
 * connection; the message is stable so consumers can match the mode failure.
 * @returns the fail-fast error for subscription and answer helpers.
 */
export function interactionsUnavailableError(): Error {
  return new Error('interaction participation is unavailable on a \'none\' connection')
}
