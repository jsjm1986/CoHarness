/** Same-origin transport for the restricted recovery page; no ordinary Admin bootstrap is required. @module */

/** Declared recovery refusal; environment evidence contains key names only. */
export class GovernanceRecoveryRequestError extends Error {
  /** @param status - HTTP result. @param code - stable server diagnostic. @param keys - withheld environment key names. */
  constructor(readonly status: number, code: string, readonly keys: string[] = []) { super(code) }
}

/** Send one explicit recovery operation; credentials and form values stay out of storage and URLs.
 * @param suffix - path beneath the governance recovery API.
 * @param method - HTTP method.
 * @param body - mutation payload, omitted for reads.
 * @param signal - cancellation of an owned read.
 * @returns decoded management identities or the operation receipt.
 */
export async function requestGovernanceRecovery<T>(suffix = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  if (suffix !== '' && !suffix.startsWith('/') && !suffix.startsWith('?')) throw new Error('Invalid recovery path')
  const response = await fetch('/admin/api/governance-recovery' + suffix, { method, credentials: 'same-origin', cache: 'no-store', signal,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const result = await response.json() as T & { error?: string; keys?: string[] }
  if (!response.ok) throw new GovernanceRecoveryRequestError(response.status, result.error ?? String(response.status), result.keys ?? [])
  return result
}
