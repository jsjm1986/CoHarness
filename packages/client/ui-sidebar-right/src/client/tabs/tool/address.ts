/** Exact Session and call addresses for auxiliary tool tabs. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Encode a tool call without depending on the currently selected Session.
 * @param sessionId - owning Session.
 * @param callId - durable call identity.
 * @returns resource address.
 */
export function toolAddress(sessionId: SessionId, callId: string): string {
  return `dsh-resource://tool/session/${encodeURIComponent(sessionId)}/${encodeURIComponent(callId)}`
}

/** Parse an untrusted persisted tool address.
 * @param address - stored or requested address.
 * @returns explicit identity, or undefined for an invalid address.
 */
export function parseToolAddress(address: string): { sessionId: SessionId; callId: string } | undefined {
  const match = /^dsh-resource:\/\/tool\/session\/([^/]+)\/([^/]+)$/u.exec(address)
  if (match === null) return undefined
  const [, encodedSession, encodedCall] = match
  /* v8 ignore if -- the pattern above captures both groups unconditionally */
  if (encodedSession === undefined || encodedCall === undefined) return undefined
  try {
    const sessionId = decodeURIComponent(encodedSession) as SessionId
    const callId = decodeURIComponent(encodedCall)
    /* v8 ignore next -- each segment matched [^/]+, so neither decode can be empty */
    return sessionId.length > 0 && callId.length > 0 ? { sessionId, callId } : undefined
  } catch (_invalidEncoding) { return undefined }
}
