/** Wire-facing view types for the remote-desktop controller namespace.
 * Branded service ids appear as plain strings on the wire.
 * @module @deepseek-ai/dsh-api-remote-desktop-controller/types
 */
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The interactive caller lacks remote-desktop authority or the administrator role. */
    'remote-desktop/forbidden': Record<string, never>
    /** The remote desktop endpoint is unreachable. */
    'remote-desktop/unavailable': Record<string, never>
    /**
     * The capability rejected the operation; `code` is the stable
     * `RemoteDesktopErrorCode` (forbidden, unavailable, grant/expiry,
     * consent-required, transport, stale-target).
     */
    'remote-desktop/failure': { code: string }
  }
}

/** Access level over the wire. */
export type RemoteDesktopLevelView = 'view' | 'control'

/** A remote node's desktop endpoint over the wire. */
export interface RemoteDesktopTargetView {
  readonly nodeId: string
  readonly desktop?: string
}

/** Grant scope over the wire. */
export type RemoteDesktopGrantScopeView =
  | { readonly kind: 'machine' }
  | { readonly kind: 'session'; readonly sessionId: string; readonly expiresAt: number }

/** One grant as the browser sees it. */
export interface RemoteDesktopGrantView {
  readonly id: string
  readonly target: RemoteDesktopTargetView
  readonly principal: string
  readonly level: RemoteDesktopLevelView
  readonly scope: RemoteDesktopGrantScopeView
  readonly recording: boolean
  readonly grantedBy: string
  readonly createdAt: number
  readonly revokedAt?: number
}

/** Attach result: spec summary plus the stream endpoint to open. */
export interface RemoteDesktopAttachView {
  readonly id: string
  readonly spec: RemoteDesktopSpecView
  readonly stream: { readonly path: string; readonly token: string }
}

/** Resolved spec summary shared by `confirm` and `attach` results. */
export interface RemoteDesktopSpecView {
  readonly target: RemoteDesktopTargetView
  readonly level: RemoteDesktopLevelView
  readonly recording: boolean
}

/** Live endpoint state plus the caller's grant summary for the `status` call. */
export interface RemoteDesktopStatusView {
  readonly target: RemoteDesktopTargetView
  readonly available: boolean
  readonly attachments: number
  readonly level: RemoteDesktopLevelView
  readonly recording: boolean
  readonly consented: boolean
}

/** Fields supplied when issuing a grant. */
export interface RemoteDesktopGrantInputView {
  readonly target: RemoteDesktopTargetView
  readonly principal: string
  readonly level: RemoteDesktopLevelView
  readonly scope: RemoteDesktopGrantScopeView
  readonly recording: boolean
}

/** Flattened audit event over the wire. */
export interface RemoteDesktopAuditEventView {
  readonly kind: 'consent' | 'grant' | 'revoke' | 'set-level' | 'attach' | 'detach' | 'level-escalate'
  readonly at: number
  readonly principal: string
  readonly target?: RemoteDesktopTargetView
  readonly grantId?: string
  readonly sessionId?: string
  readonly level?: RemoteDesktopLevelView
  readonly from?: RemoteDesktopLevelView
  readonly to?: RemoteDesktopLevelView
}
