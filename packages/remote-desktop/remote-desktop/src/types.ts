/** Vocabulary for the remote-desktop Service Definition (`ctx.remoteDesktop`):
 * targets, grant scopes and levels, the resolved spec, live attachments, and
 * the audit-event taxonomy. Human-facing capability — no model-visible text.
 * @module @deepseek-ai/dsh-remote-desktop/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteDesktopGrantId, RemoteDesktopSessionId, RemoteDesktopToken } from './brand.ts'

/** Stable machine-readable failure codes for API and audit surfaces. */
export type RemoteDesktopErrorCode =
  | 'REMOTE_DESKTOP_FORBIDDEN'
  | 'REMOTE_DESKTOP_TARGET_UNAVAILABLE'
  | 'REMOTE_DESKTOP_GRANT_NOT_FOUND'
  | 'REMOTE_DESKTOP_GRANT_EXPIRED'
  | 'REMOTE_DESKTOP_STALE_TARGET'
  | 'REMOTE_DESKTOP_TRANSPORT'

/** Access level an attachment may use; `control` strictly exceeds `view`. */
export type RemoteDesktopLevel = 'view' | 'control'

/** A remote node's desktop endpoint. `nodeId` names the machine per project routing. */
export interface RemoteDesktopTarget {
  /** The remote node that owns the desktop. */
  readonly nodeId: string
  /** Desktop identity on the node; omitted selects the primary desktop. */
  readonly desktop?: string
}

/** Grant lifetime scope: durable machine access or a bounded session grant. */
export type RemoteDesktopGrantScope =
  | { readonly kind: 'machine' }
  | { readonly kind: 'session'; readonly sessionId: SessionId; readonly expiresAt: number }

/** One administrator-issued access grant to a desktop. */
export interface RemoteDesktopGrant {
  readonly id: RemoteDesktopGrantId
  readonly target: RemoteDesktopTarget
  /** Opaque authorized principal (user or account identity). */
  readonly principal: string
  readonly level: RemoteDesktopLevel
  readonly scope: RemoteDesktopGrantScope
  /** Whether attachments under this grant require screen recording. */
  readonly recording: boolean
  readonly grantedBy: string
  readonly createdAt: number
  readonly revokedAt?: number
}

/** Fields an administrator supplies when issuing a grant. */
export type RemoteDesktopGrantInput = Omit<RemoteDesktopGrant, 'id' | 'createdAt' | 'revokedAt'>

/** Live remote state of one desktop endpoint. */
export interface RemoteDesktopTargetStatus {
  readonly target: RemoteDesktopTarget
  /** The node's desktop transport is reachable. */
  readonly available: boolean
  /** Current attachments on this desktop. */
  readonly attachments: number
}

/** Explicit resolve outcome — the enforced attachment contract. */
export interface RemoteDesktopSpec {
  readonly target: RemoteDesktopTarget
  /** Effective level: never exceeds the matching grants. */
  readonly level: RemoteDesktopLevel
  /** The grant(s) authorizing this spec. */
  readonly grants: readonly RemoteDesktopGrant[]
  /** Whether screen recording applies to this attachment. */
  readonly recording: boolean
}

/** Caller request for `RemoteDesktop.resolve` and `RemoteDesktop.attach`. */
export interface RemoteDesktopAttachRequest {
  /** Authenticated principal requesting access, supplied by the API layer. */
  readonly principal: string
  readonly target: RemoteDesktopTarget
  /** Session address for session-scoped grant matching; omit for machine-only. */
  readonly sessionId?: SessionId
  /** Requested level; resolution fails rather than widening past granted level. */
  readonly level: RemoteDesktopLevel
}

/** Stream endpoint the browser client opens for one attachment. */
export interface RemoteDesktopStream {
  /** RFB-over-WebSocket path served by the provider. */
  readonly path: string
  /** One-time attach token; validated at the stream handshake. */
  readonly token: RemoteDesktopToken
}

/** One live attachment; `detach` releases the desktop and its stream. */
export interface RemoteDesktopSession {
  readonly id: RemoteDesktopSessionId
  readonly spec: RemoteDesktopSpec
  readonly stream: RemoteDesktopStream
  detach(signal?: AbortSignal): Promise<void>
}

/** Admin filters for grant listing; omitted fields match all. */
export interface RemoteDesktopGrantFilter {
  readonly target?: RemoteDesktopTarget
  readonly principal?: string
  readonly includeRevoked?: boolean
}

/** The authenticated human or administrator an action is attributed to. */
export interface RemoteDesktopActor {
  readonly principal: string
  readonly admin: boolean
}

/** Audit events owned by this capability; consumers record them in the audit domain. */
export type RemoteDesktopAuditEvent =
  | { readonly kind: 'grant'; readonly grant: RemoteDesktopGrant; readonly actor: RemoteDesktopActor; readonly at: number }
  | { readonly kind: 'revoke' | 'set-level'; readonly grant: RemoteDesktopGrant; readonly actor: RemoteDesktopActor; readonly at: number }
  | { readonly kind: 'attach' | 'detach'; readonly session: RemoteDesktopSessionId; readonly spec: RemoteDesktopSpec; readonly principal: string; readonly at: number }
  | { readonly kind: 'level-escalate'; readonly session: RemoteDesktopSessionId; readonly from: RemoteDesktopLevel; readonly to: RemoteDesktopLevel; readonly principal: string; readonly at: number }
