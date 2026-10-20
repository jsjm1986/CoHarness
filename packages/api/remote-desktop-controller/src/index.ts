/** Browser-facing BFF controller for `ctx.remoteDesktop`: every method verifies
 * the authenticated human's verified principal into the actor, and never
 * trusts a caller-supplied actor. Session-scoped methods (`status`, `attach`)
 * bind the addressed session; management methods additionally require the
 * administrator role.
 * @module @deepseek-ai/dsh-api-remote-desktop-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteDesktopError, RemoteDesktopGrantId } from '@deepseek-ai/dsh-remote-desktop'
import type { RemoteDesktopActor, RemoteDesktopAuditEvent, RemoteDesktopGrant } from '@deepseek-ai/dsh-remote-desktop'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteDesktopAccess } from './authorization.ts'
import type {
  RemoteDesktopAttachView,
  RemoteDesktopAuditEventView,
  RemoteDesktopGrantInputView,
  RemoteDesktopGrantView,
  RemoteDesktopLevelView,
  RemoteDesktopSpecView,
  RemoteDesktopStatusView,
  RemoteDesktopTargetView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote-desktop BFF controller. */
    remoteDesktopController: RemoteDesktopController
  }
}

function grantView(grant: RemoteDesktopGrant): RemoteDesktopGrantView {
  return { ...grant, id: String(grant.id) }
}

/** Translate capability rejections into typed wire errors clients can branch on. */
function translate(error: unknown): never {
  if (error instanceof RemoteDesktopError) {
    throw new RemoteError('remote-desktop/failure', error.message, { code: error.code })
  }
  throw error
}

function auditView(event: RemoteDesktopAuditEvent): RemoteDesktopAuditEventView {
  switch (event.kind) {
    case 'consent':
      return { kind: 'consent', at: event.at, principal: event.principal, target: event.target, level: event.level }
    case 'grant':
    case 'revoke':
    case 'set-level':
      return {
        kind: event.kind,
        at: event.at,
        principal: event.actor.principal,
        target: event.grant.target,
        grantId: String(event.grant.id),
      }
    case 'attach':
    case 'detach':
      return {
        kind: event.kind,
        at: event.at,
        principal: event.principal,
        target: event.spec.target,
        sessionId: String(event.session),
      }
    case 'level-escalate':
      return { kind: 'level-escalate', at: event.at, principal: event.principal, sessionId: String(event.session), from: event.from, to: event.to }
    default:
      return assertNever(event)
  }
}

/**
 * `remoteDesktop/*` Remote namespace. Every call resolves the caller's actor
 * from the request's verified principal, then delegates enforcement to
 * `ctx.remoteDesktop` (grant matching, level caps, administrator checks). The
 * browser-visible principal is always the verified user, never caller input.
 */
export class RemoteDesktopController extends TypertRemoteService {
  /** The grant-enforcing provider plus the Remote descriptor registry. */
  static inject = ['remoteDesktop', 'typert']

  private readonly access: RemoteDesktopAccess

  /**
   * @param ctx - Host context carrying the remote-desktop capability and the
   *   managed deployment's runtime principal provider.
   */
  constructor(ctx: Context) {
    super(ctx, 'remoteDesktopController', { namespace: 'remoteDesktop' })
    this.access = new RemoteDesktopAccess(ctx)
  }

  /**
   * Live state of one desktop endpoint for the caller.
   * @param agent - caller's Session owner; also the session-grant address.
   * @param request - the desktop to probe.
   * @param signal - request cancellation.
   * @returns endpoint availability and attachment count.
   */
  @Remote
  async status(agent: Agent, request: RemoteDesktopTargetView, signal: AbortSignal): Promise<RemoteDesktopStatusView> {
    const actor = this.access.actor(signal)
    return await this.ctx.remoteDesktop.status(actor, request, { sessionId: agent.id }).catch(translate)
  }

  /**
   * Record the caller's explicit consent for a resolved spec; the returned
   * summary is what the operator acknowledged (level plus recording flag).
   * @param agent - caller's Session owner; session-scoped grants match its id.
   * @param request - target plus the level being consented to.
   * @param signal - request cancellation.
   * @returns the resolved spec the consent now covers.
   */
  @Remote
  async confirm(
    agent: Agent,
    request: RemoteDesktopTargetView & { level: RemoteDesktopLevelView },
    signal: AbortSignal,
  ): Promise<RemoteDesktopSpecView> {
    const actor = this.access.actor(signal)
    const spec = await this.ctx.remoteDesktop.confirm({
      principal: actor.principal,
      target: { nodeId: request.nodeId, ...(request.desktop === undefined ? {} : { desktop: request.desktop }) },
      sessionId: agent.id,
      level: request.level,
    }).catch(translate)
    return { target: spec.target, level: spec.level, recording: spec.recording }
  }

  /**
   * Open one attachment under the caller's grants.
   * @param agent - caller's Session owner; session-scoped grants match its id.
   * @param request - target plus requested level.
   * @param signal - request cancellation.
   * @returns the attachment id and one-time stream endpoint.
   */
  @Remote
  async attach(
    agent: Agent,
    request: RemoteDesktopTargetView & { level: RemoteDesktopLevelView },
    signal: AbortSignal,
  ): Promise<RemoteDesktopAttachView> {
    const actor = this.access.actor(signal)
    const session = await this.ctx.remoteDesktop.attach({
      principal: actor.principal,
      target: { nodeId: request.nodeId, ...(request.desktop === undefined ? {} : { desktop: request.desktop }) },
      sessionId: agent.id,
      level: request.level,
    }).catch(translate)
    return {
      id: String(session.id),
      spec: { target: session.spec.target, level: session.spec.level, recording: session.spec.recording },
      stream: { path: session.stream.path, token: String(session.stream.token) },
    }
  }

  /**
   * Grants visible to the caller: administrators see all; others see only
   * rows for their own principal (the service enforces the same scoping).
   * @param agent - caller's Session address bound for routing.
   * @param request - optional principal and revoked-row inclusion.
   * @param signal - request cancellation.
   * @returns matching grants, newest administration first.
   */
  @Remote
  async listGrants(
    agent: Agent,
    request: { principal?: string; includeRevoked?: boolean },
    signal: AbortSignal,
  ): Promise<RemoteDesktopGrantView[]> {
    const actor = this.access.actor(signal)
    void agent // Wire-bound routing address; the actor comes from the request principal.
    const rows = await this.ctx.remoteDesktop.listGrants(actor, {
      ...(request.principal === undefined ? {} : { principal: request.principal }),
      ...(request.includeRevoked === undefined ? {} : { includeRevoked: request.includeRevoked }),
    })
    return rows.map(grantView)
  }

  /**
   * Issue a grant; administrator authority required.
   * @param agent - administrator's Session address bound for routing.
   * @param request - grant fields; `grantedBy` is the verified caller.
   * @param signal - request cancellation.
   * @returns the stored grant row.
   */
  @Remote
  async grant(agent: Agent, request: RemoteDesktopGrantInputView, signal: AbortSignal): Promise<RemoteDesktopGrantView> {
    const actor = this.adminActor(signal)
    void agent // Wire-bound routing address; the actor comes from the request principal.
    const grant = await this.ctx.remoteDesktop.grant({
      target: request.target,
      principal: request.principal,
      level: request.level,
      scope: request.scope.kind === 'machine'
        ? { kind: 'machine' }
        : { kind: 'session', sessionId: SessionId(request.scope.sessionId), expiresAt: request.scope.expiresAt },
      recording: request.recording,
      grantedBy: actor.principal,
    }, actor)
    return grantView(grant)
  }

  /**
   * Change a grant's level; administrator authority required.
   * @param agent - administrator's Session address bound for routing.
   * @param request - grant id and new level.
   * @param signal - request cancellation.
   * @returns the updated grant row.
   */
  @Remote
  async setLevel(
    agent: Agent,
    request: { grantId: string; level: RemoteDesktopLevelView },
    signal: AbortSignal,
  ): Promise<RemoteDesktopGrantView> {
    const actor = this.adminActor(signal)
    void agent // Wire-bound routing address; the actor comes from the request principal.
    const grant = await this.ctx.remoteDesktop.setLevel(RemoteDesktopGrantId(request.grantId), request.level, actor)
    return grantView(grant)
  }

  /**
   * Revoke a grant; administrator authority required.
   * @param agent - administrator's Session address bound for routing.
   * @param request - grant id.
   * @param signal - request cancellation.
   * @returns the revoked grant row.
   */
  @Remote
  async revoke(agent: Agent, request: { grantId: string }, signal: AbortSignal): Promise<RemoteDesktopGrantView> {
    const actor = this.adminActor(signal)
    void agent // Wire-bound routing address; the actor comes from the request principal.
    const grant = await this.ctx.remoteDesktop.revoke(RemoteDesktopGrantId(request.grantId), actor)
    return grantView(grant)
  }

  /**
   * Audit events visible to the caller, newest first; non-administrators are
   * restricted to events touching their own principal.
   * @param agent - caller's Session address bound for routing.
   * @param request - optional target and principal filters.
   * @param signal - request cancellation.
   * @returns matching audit events.
   */
  @Remote
  async audit(
    agent: Agent,
    request: { principal?: string; target?: RemoteDesktopTargetView },
    signal: AbortSignal,
  ): Promise<RemoteDesktopAuditEventView[]> {
    const actor = this.access.actor(signal)
    void agent // Wire-bound routing address; the actor comes from the request principal.
    const events = await this.ctx.remoteDesktop.audit(actor, {
      ...(request.principal === undefined ? {} : { principal: request.principal }),
      ...(request.target === undefined ? {} : { target: request.target }),
    }).catch(translate)
    return events.map(auditView)
  }

  private adminActor(signal: AbortSignal): RemoteDesktopActor {
    const actor = this.access.actor(signal)
    if (!actor.admin) {
      throw new RemoteError('remote-desktop/forbidden', 'Remote-desktop administration requires an administrator.', {})
    }
    return actor
  }
}

export default RemoteDesktopController
