/** Temporary review previews carry their document in in-memory tab navigation. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PlanDocument } from './plan.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** Review text without a logged invocation; never persisted in sidebar layout. */
    'plan-review': { planReview: PlanDocument }
  }
}

/**
 * Name one temporary review within its browser lifetime and Session.
 * @param sessionId - Session displaying the review.
 * @param requestKey - Browser-unique pending request identity.
 * @returns the address used to focus or reopen its preview.
 */
export function reviewPreviewAddress(sessionId: SessionId, requestKey: string): string {
  return `dsh-resource://plan-review/${encodeURIComponent(sessionId)}/${encodeURIComponent(requestKey)}`
}

/**
 * Recognize temporary plan navigation without interpreting it as logged history.
 * @param address - Saved or caller-supplied navigation address.
 * @returns whether the address identifies a temporary review preview.
 */
export function isReviewPreviewAddress(address: string): boolean {
  return /^dsh-resource:\/\/plan-review\/[^/?#]+\/[^/?#]+$/.test(address)
}

/**
 * Validate a temporary review address for the Sidebar type's owner lookup.
 * @param address - address claimed by the `plan` tab type.
 * @returns the decoded Session identity, or undefined for an invalid address.
 */
export function parseReviewPreviewAddress(address: string): { readonly sessionId: SessionId } | undefined {
  const match = /^dsh-resource:\/\/plan-review\/([^/?#]+)\/[^/?#]+$/.exec(address)
  if (match === null) return undefined
  try {
    const sessionId = decodeURIComponent(match[1] as string)
    return { sessionId: sessionId as SessionId }
  } catch {
    // Invalid percent encoding cannot identify a Session.
    return undefined
  }
}
