/** Remote Desktop Service Definition (`ctx.remoteDesktop`): the human-facing
 * capability for viewing and operating a remote node's desktop. Providers own
 * transport and endpoint resolution; grants, levels, and audit are defined
 * here so every consumer shares one contract.
 * @module @deepseek-ai/dsh-remote-desktop
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Duplex } from 'node:stream'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteDesktopGrantId, RemoteDesktopToken } from './brand.ts'
import type {
  RemoteDesktopActor,
  RemoteDesktopAttachRequest,
  RemoteDesktopAuditEvent,
  RemoteDesktopErrorCode,
  RemoteDesktopGrant,
  RemoteDesktopGrantFilter,
  RemoteDesktopGrantInput,
  RemoteDesktopGrantScope,
  RemoteDesktopLevel,
  RemoteDesktopSession,
  RemoteDesktopSpec,
  RemoteDesktopStream,
  RemoteDesktopTarget,
  RemoteDesktopTargetStatus,
} from './types.ts'

/** Typed failure for grant, attach, and stream operations. */
export class RemoteDesktopError extends Error {
  constructor(message: string, readonly code: RemoteDesktopErrorCode) {
    super(message)
    this.name = 'RemoteDesktopError'
  }
}

/** Numeric rank for level comparison: `view` ranks below `control`. */
export function levelRank(level: RemoteDesktopLevel): number {
  return level === 'control' ? 1 : 0
}

export {
  RemoteDesktopGrantId,
  RemoteDesktopSessionId,
  RemoteDesktopToken,
} from './brand.ts'
export type {
  RemoteDesktopActor,
  RemoteDesktopAttachRequest,
  RemoteDesktopAuditEvent,
  RemoteDesktopErrorCode,
  RemoteDesktopGrant,
  RemoteDesktopGrantFilter,
  RemoteDesktopGrantInput,
  RemoteDesktopGrantScope,
  RemoteDesktopLevel,
  RemoteDesktopSession,
  RemoteDesktopSpec,
  RemoteDesktopStream,
  RemoteDesktopTarget,
  RemoteDesktopTargetStatus,
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteDesktop: RemoteDesktop
  }

  interface Events {
    /**
     * Emitted after the grant set changes (grant/revoke committed).
     * Listeners refresh admin views and cached authorizations.
     * @mode emit
     */
    'remote-desktop/grants-changed'(): void
    /**
     * Emitted after an attachment opens or closes.
     * @param session - the attachment whose lifecycle event committed.
     * @param attached - true after attach commits; false after detach commits.
     * @mode emit
     */
    'remote-desktop/attached'(session: RemoteDesktopSession, attached: boolean): void
  }
}

/**
 * Remote-desktop capability. `resolve` is the enforced decision point:
 * it computes the effective spec from matching grants and throws
 * `REMOTE_DESKTOP_FORBIDDEN` rather than silently widening or narrowing.
 * `attach` runs the resolved spec; grant and audit operations attribute
 * actions to an explicit {@link RemoteDesktopActor}.
 */
export abstract class RemoteDesktop extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remoteDesktop')
  }

  /**
   * Resolve an attach request into an enforced spec: match live grants,
   * compute the effective level (never exceeding grants), and decide the
   * recording flag. Throws {@link RemoteDesktopError} with
   * `REMOTE_DESKTOP_FORBIDDEN` when no live grant authorizes the request.
   */
  abstract resolve(request: RemoteDesktopAttachRequest, signal?: AbortSignal): Promise<RemoteDesktopSpec>

  /**
   * Record the caller's explicit consent for a resolved spec. Implementations
   * resolve the request first (rejecting unauthorized targets), persist the
   * consent against the resolved grant set and requested level, record a
   * `consent` audit event, and return the spec so the caller learns the
   * effective level and recording flag it acknowledged.
   */
  abstract confirm(request: RemoteDesktopAttachRequest, signal?: AbortSignal): Promise<RemoteDesktopSpec>

  /**
   * Open one attachment. Implementations resolve first — and require a
   * consent recorded by {@link confirm} that covers the resolved grant set
   * at the requested level, throwing `REMOTE_DESKTOP_CONSENT_REQUIRED`
   * otherwise — then establish the transport and stream endpoint; the
   * returned session owns detach.
   */
  abstract attach(request: RemoteDesktopAttachRequest, signal?: AbortSignal): Promise<RemoteDesktopSession>

  /**
   * Serve one upgraded stream connection for a token minted by `attach`.
   * The transport layer calls this after its handshake; the implementation
   * consumes the token exactly once, resolves the pending spec, and pumps
   * the desktop protocol with the effective level enforced inside the pump.
   */
  abstract serveStream(token: RemoteDesktopToken, socket: Duplex, signal?: AbortSignal): Promise<void>

  /**
   * Read the live remote state of one desktop endpoint.
   * Requires at least one live grant for `actor.principal` on the target;
   * `options.sessionId` admits session-scoped grants into the summary.
   * @returns availability, attachment count, and the caller's grant summary.
   */
  abstract status(
    actor: RemoteDesktopActor,
    target: RemoteDesktopTarget,
    options?: { sessionId?: SessionId },
    signal?: AbortSignal,
  ): Promise<RemoteDesktopTargetStatus>

  /**
   * List grants, optionally filtered; revoked rows need `includeRevoked`.
   * Non-admin actors are restricted to their own principal.
   */
  abstract listGrants(actor: RemoteDesktopActor, filter?: RemoteDesktopGrantFilter, signal?: AbortSignal): Promise<RemoteDesktopGrant[]>

  /**
   * Issue a grant. `actor.admin === true` is required; implementations
   * publish `remote-desktop/grants-changed` only after the write commits.
   */
  abstract grant(input: RemoteDesktopGrantInput, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant>

  /** Change a grant's access level; `actor.admin === true` required. */
  abstract setLevel(id: RemoteDesktopGrantId, level: RemoteDesktopLevel, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant>

  /** Revoke a grant by id; `actor.admin === true` required. */
  abstract revoke(id: RemoteDesktopGrantId, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant>

  /**
   * Query audit events owned by this capability, newest first.
   * Non-admin actors are restricted to their own principal.
   * @returns recorded events; providers may cap the result window.
   */
  abstract audit(
    actor: RemoteDesktopActor,
    filter?: { target?: RemoteDesktopTarget; principal?: string },
    signal?: AbortSignal,
  ): Promise<RemoteDesktopAuditEvent[]>
}

export default RemoteDesktop
