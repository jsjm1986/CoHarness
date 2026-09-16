/**
 * Client-safe collaboration contracts: participant, access, authority, and the
 * Remote refusal vocabulary shared by Gateway-backed Consumers.
 * @module @deepseek-ai/dsh-collaboration/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Authorization verbs applied to a root conversation ACL. */
export type CollaborationAction = 'read' | 'write' | 'manage' | 'approve'

/** Human interaction classes that accept exactly one committed response. */
export type CollaborationInteractionKind = 'approval' | 'question'

/** Visibility of one root conversation inside a project runtime. */
export type CollaborationVisibility = 'project' | 'private'

/** Authenticated human participant attached to one request. */
export interface CollaborationParticipant {
  readonly userId: number
  readonly username: string
  readonly displayName: string
  readonly role: 'admin' | 'user'
  readonly scope:
    | { readonly kind: 'personal' }
    | {
      readonly kind: 'project'
      readonly projectId: number
      readonly projectName: string
      readonly mode: 'ro' | 'rw'
      readonly canManage?: boolean
    }
}

/** Root-inherited access facts returned after authorization succeeds. */
export interface CollaborationAccess {
  readonly sessionId: SessionId
  readonly rootSessionId: SessionId
  readonly mode: 'ro' | 'rw'
  readonly canRead: true
  readonly canWrite: boolean
  readonly canManage: boolean
  readonly projectId?: number
  readonly visibility?: CollaborationVisibility
  readonly creatorUserId?: number
}

/** Request-scoped metadata for a new root conversation. */
export interface CollaborationSessionCreation {
  readonly visibility: CollaborationVisibility
}

/** Principal-bound collaboration operations safe to retain for one request or stream lifetime. */
export interface CollaborationAuthority {
  readonly participant: CollaborationParticipant
  /** Assertion expiry; long-lived streams reconnect no later than this instant. */
  readonly expiresAt: number
  /** Aborts when the provider that issued this authority unloads. */
  readonly signal: AbortSignal

  /**
   * Authorize one operation against the session's root ACL.
   * @param sessionId - requested root or descendant session.
   * @param action - operation class to authorize.
   * @returns root-inherited access facts.
   */
  authorize(sessionId: SessionId, action: CollaborationAction): Promise<CollaborationAccess>

  /**
   * Filter a batch to sessions this participant may read.
   * @param sessionIds - candidate root or descendant session ids.
   * @returns the readable subset.
   */
  readableSessionIds(sessionIds: readonly SessionId[]): Promise<ReadonlySet<SessionId>>

  /**
   * Atomically claim one pending human response for a shared conversation.
   * @param sessionId - session that emitted the approval request.
   * @param kind - interaction class whose ids occupy an independent namespace.
   * @param interactionId - stable approval or question request id.
   * @param outcome - exact response payload being committed.
   * @returns true for the first accepted responder; false after another responder won.
   */
  claimInteraction(
    sessionId: SessionId,
    kind: CollaborationInteractionKind,
    interactionId: string,
    outcome: unknown,
  ): Promise<boolean>
}

/** Stable failure codes shared by Gateway-backed Consumers. */
export type CollaborationErrorCode =
  | 'not-member'
  | 'conversation-not-found'
  | 'forbidden'
  | 'visibility-locked'
  | 'gateway-unavailable'

/** Wire refusal for a project-membership or conversation-ACL failure: code, message, and details. */
export interface CollaborationRefusal {
  readonly code: 'collaboration-forbidden'
  readonly message: string
  readonly details: {
    readonly action: CollaborationAction
    readonly reason: CollaborationErrorCode
    readonly sessionId?: SessionId
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Project collaboration refused the Remote action on the addressed Session. */
    'collaboration-forbidden': CollaborationRefusal['details']
  }
}
