/** Browser-facing BFF controller for `ctx.remoteDesktop`: every method verifies
 * the authenticated human's session authority, resolves the actor, and never
 * trusts a caller-supplied actor. Session-scoped methods (`status`, `attach`)
 * authorize the addressed session; management methods additionally require
 * administrator authority.
 * @module @deepseek-ai/dsh-api-remote-desktop-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteDesktopGrantId } from '@deepseek-ai/dsh-remote-desktop'
import type { RemoteDesktopActor, RemoteDesktopAuditEvent, RemoteDesktopGrant } from '@deepseek-ai/dsh-remote-desktop'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteDesktopAccess } from './authorization.ts'
import type {
  RemoteDesktopAttachView,
  RemoteDesktopAuditEventView,
  RemoteDesktopGrantInputView,
  RemoteDesktopGrantView,
  RemoteDesktopLevelView,
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

function auditView(event: RemoteDesktopAuditEvent): RemoteDesktopAuditEventView {
  switch (event.kind) {
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
 * `remoteDesktop/*` Remote namespace. Every call authorizes the caller's own
 * Session for identity, then delegates enforcement to `ctx.remoteDesktop`
 * (grant matching, level caps) and the administrator policy (management
 * methods). The browser-visible principal is always the verified creator.
 */
export class RemoteDesktopController extends TypertRemoteService {
  private readonly lifetime = new AbortController()
  private readonly access: RemoteDesktopAccess

  /**
   * @param ctx - Host context carrying the remote-desktop capability and the
   *   shared user-authorization/administration policies.
   */
  constructor(ctx: Context) {
    super(ctx, 'remoteDesktopController', { namespace: 'remoteDesktop' })
    this.access = new RemoteDesktopAccess(ctx, this.lifetime.signal)
    ctx.effect(() => () => this.lifetime.abort(new Error('Remote-desktop controller disposed')), 'remote-desktop-controller.access')
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
    using authority = await this.access.authorize(agent.id, signal)
    const actor: RemoteDesktopActor = { principal: String(authority.creator), admin: false }
    return await this.ctx.remoteDesktop.status(actor, request)
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
    using authority = await this.access.authorize(agent.id, signal)
    const session = await this.ctx.remoteDesktop.attach({
      principal: String(authority.creator),
      target: { nodeId: request.nodeId, ...(request.desktop === undefined ? {} : { desktop: request.desktop }) },
      sessionId: agent.id,
      level: request.level,
    })
    return {
      id: String(session.id),
      spec: { target: session.spec.target, level: session.spec.level, recording: session.spec.recording },
      stream: { path: session.stream.path, token: String(session.stream.token) },
    }
  }

  /**
   * Grants visible to the caller: administrators see all; others see only
   * rows for their own principal (the service enforces the same scoping).
   * @param agent - caller's Session owner.
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
    using authority = await this.access.authorize(agent.id, signal)
    const actor: RemoteDesktopActor = {
      principal: String(authority.creator),
      admin: await this.access.administrator(signal),
    }
    const rows = await this.ctx.remoteDesktop.listGrants(actor, {
      ...(request.principal === undefined ? {} : { principal: request.principal }),
      ...(request.includeRevoked === undefined ? {} : { includeRevoked: request.includeRevoked }),
    })
    return rows.map(grantView)
  }

  /**
   * Issue a grant; administrator authority required.
   * @param agent - administrator's Session owner.
   * @param request - grant fields; `grantedBy` is the verified caller.
   * @param signal - request cancellation.
   * @returns the stored grant row.
   */
  @Remote
  async grant(agent: Agent, request: RemoteDesktopGrantInputView, signal: AbortSignal): Promise<RemoteDesktopGrantView> {
    using authority = await this.access.authorize(agent.id, signal)
    const actor = await this.adminActor(String(authority.creator), signal)
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
   * @param agent - administrator's Session owner.
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
    using authority = await this.access.authorize(agent.id, signal)
    const actor = await this.adminActor(String(authority.creator), signal)
    const grant = await this.ctx.remoteDesktop.setLevel(RemoteDesktopGrantId(request.grantId), request.level, actor)
    return grantView(grant)
  }

  /**
   * Revoke a grant; administrator authority required.
   * @param agent - administrator's Session owner.
   * @param request - grant id.
   * @param signal - request cancellation.
   * @returns the revoked grant row.
   */
  @Remote
  async revoke(agent: Agent, request: { grantId: string }, signal: AbortSignal): Promise<RemoteDesktopGrantView> {
    using authority = await this.access.authorize(agent.id, signal)
    const actor = await this.adminActor(String(authority.creator), signal)
    const grant = await this.ctx.remoteDesktop.revoke(RemoteDesktopGrantId(request.grantId), actor)
    return grantView(grant)
  }

  /**
   * Audit events visible to the caller, newest first; non-administrators are
   * restricted to events touching their own principal.
   * @param agent - caller's Session owner.
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
    using authority = await this.access.authorize(agent.id, signal)
    const actor: RemoteDesktopActor = {
      principal: String(authority.creator),
      admin: await this.access.administrator(signal),
    }
    const events = await this.ctx.remoteDesktop.audit(actor, {
      ...(request.principal === undefined ? {} : { principal: request.principal }),
      ...(request.target === undefined ? {} : { target: request.target }),
    })
    return events.map(auditView)
  }

  private async adminActor(principal: string, signal: AbortSignal): Promise<RemoteDesktopActor> {
    if (!(await this.access.administrator(signal))) {
      throw new RemoteError('remote-desktop/forbidden', 'Remote-desktop administration requires an administrator.', {})
    }
    return { principal, admin: true }
  }
}

export default RemoteDesktopController
