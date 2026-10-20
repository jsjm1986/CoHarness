/** Client remote-desktop model service: `ctx.remoteDesktops` wraps the
 * generated `remoteDesktop` Remote namespace, translating wire results into
 * thrown errors and resolving one-time stream endpoints to WebSocket URLs.
 * @module @deepseek-ai/dsh-api-remote-desktop-controller/client
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {
  RemoteDesktopAuditEventView, RemoteDesktopGrantInputView, RemoteDesktopGrantView,
  RemoteDesktopLevelView, RemoteDesktopSpecView, RemoteDesktopStatusView, RemoteDesktopTargetView,
} from '../types.ts'

/** The `remoteDesktop` Remote namespace this service consumes. */
export type RemoteDesktopRemote = Pick<ClientRemote['remoteDesktop'],
  'status' | 'confirm' | 'attach' | 'listGrants' | 'grant' | 'setLevel' | 'revoke' | 'audit'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Human remote-desktop status, consent, attach, grant administration, and audit. */
    remoteDesktops: ClientRemoteDesktops
  }
}

/** A minted desktop attachment: spec summary plus the resolved stream URL to open. */
export interface RemoteDesktopAttachment {
  readonly id: string
  readonly spec: RemoteDesktopSpecView
  /** Absolute WebSocket URL including the one-time `token` query parameter. */
  readonly url: string
}

/**
 * Human remote-desktop calls over the verified Remote transport. Management
 * methods reach the server only under administrator authority; the service
 * re-validates every call, so a UI can offer the actions unconditionally and
 * surface `remote-desktop/forbidden` when the caller is not an administrator.
 */
export class ClientRemoteDesktops extends Service {
  /**
   * @param ctx - Client root Context.
   * @param remote - generated `remoteDesktop` namespace.
   */
  constructor(ctx: Context, private readonly remote: RemoteDesktopRemote) {
    super(ctx, 'remoteDesktops')
  }

  /**
   * Live endpoint state plus the caller's grant summary.
   * @param sessionId - Session the call is scoped to; session-scoped grants match its id.
   * @param target - desktop endpoint to probe.
   * @param signal - request cancellation.
   * @returns availability, attachment count, effective level, and consent coverage.
   */
  async status(sessionId: SessionId, target: RemoteDesktopTargetView, signal: AbortSignal): Promise<RemoteDesktopStatusView> {
    const result = await this.remote.status(sessionId, target, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Record the caller's explicit consent for a resolved spec.
   * @param sessionId - Session the call is scoped to.
   * @param target - desktop endpoint being consented to.
   * @param level - requested access level.
   * @param signal - request cancellation.
   * @returns the resolved spec the consent now covers.
   */
  async confirm(
    sessionId: SessionId, target: RemoteDesktopTargetView, level: RemoteDesktopLevelView, signal: AbortSignal,
  ): Promise<RemoteDesktopSpecView> {
    const result = await this.remote.confirm(sessionId, { ...target, level }, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Open one attachment under the caller's grants; consent must already cover
   * the resolved grant set.
   * @param sessionId - Session the call is scoped to.
   * @param target - desktop endpoint to attach.
   * @param level - requested access level.
   * @param signal - request cancellation.
   * @returns the attachment id plus an absolute `ws(s)://` stream URL.
   */
  async attach(
    sessionId: SessionId, target: RemoteDesktopTargetView, level: RemoteDesktopLevelView, signal: AbortSignal,
  ): Promise<RemoteDesktopAttachment> {
    const result = await this.remote.attach(sessionId, { ...target, level }, signal)
    if (!result.ok) throw result.error
    const url = new URL(result.value.stream.path, location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = `token=${encodeURIComponent(result.value.stream.token)}`
    return { id: result.value.id, spec: result.value.spec, url: url.href }
  }

  /**
   * Grants the caller may see: administrators see all rows; other callers see
   * their own principal's rows.
   * @param sessionId - Session the call is scoped to.
   * @param filter - optional principal restriction and revoked-row inclusion.
   * @param signal - request cancellation.
   * @returns matching grant rows, newest administration first.
   */
  async listGrants(
    sessionId: SessionId, filter: { principal?: string; includeRevoked?: boolean }, signal: AbortSignal,
  ): Promise<RemoteDesktopGrantView[]> {
    const result = await this.remote.listGrants(sessionId, filter, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Issue a grant; administrator authority required.
   * @param sessionId - administrator's Session.
   * @param input - grant fields; `grantedBy` is the verified caller server-side.
   * @param signal - request cancellation.
   * @returns the stored grant row.
   */
  async grant(sessionId: SessionId, input: RemoteDesktopGrantInputView, signal: AbortSignal): Promise<RemoteDesktopGrantView> {
    const result = await this.remote.grant(sessionId, input, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Change a grant's level; administrator authority required.
   * @param sessionId - administrator's Session.
   * @param grantId - grant to update.
   * @param level - new level.
   * @param signal - request cancellation.
   * @returns the updated grant row.
   */
  async setLevel(
    sessionId: SessionId, grantId: string, level: RemoteDesktopLevelView, signal: AbortSignal,
  ): Promise<RemoteDesktopGrantView> {
    const result = await this.remote.setLevel(sessionId, { grantId, level }, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Revoke a grant; administrator authority required.
   * @param sessionId - administrator's Session.
   * @param grantId - grant to revoke.
   * @param signal - request cancellation.
   * @returns the revoked grant row.
   */
  async revoke(sessionId: SessionId, grantId: string, signal: AbortSignal): Promise<RemoteDesktopGrantView> {
    const result = await this.remote.revoke(sessionId, { grantId }, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Audit events visible to the caller, newest first; non-administrators are
   * restricted to events touching their own principal.
   * @param sessionId - Session the call is scoped to.
   * @param filter - optional target and principal filters.
   * @param signal - request cancellation.
   * @returns matching audit events.
   */
  async audit(
    sessionId: SessionId, filter: { principal?: string; target?: RemoteDesktopTargetView }, signal: AbortSignal,
  ): Promise<RemoteDesktopAuditEventView[]> {
    const result = await this.remote.audit(sessionId, filter, signal)
    if (!result.ok) throw result.error
    return result.value
  }
}

/** Required Client transport plus the generated `remoteDesktop` namespace. */
export const inject = ['remote']

/**
 * Remote namespaces this plugin self-mounts through `ctx.remote.$mount`. The
 * generated contribution exists only in built `lib/`; test assemblies stand in
 * by providing `remote.remoteDesktop` before this row activates.
 */
export const remoteNamespaces = ['remoteDesktop'] as const

/**
 * Install the Client remote-desktop model, self-mounting the generated
 * `remoteDesktop` Remote contribution unless the assembly provides it.
 * @param ctx - Client root Context.
 */
export async function apply(ctx: Context): Promise<void> {
  if (ctx.get('remote.remoteDesktop') === undefined) {
    const { default: remoteDesktopRemote } = await import('@deepseek-ai/dsh-api-remote-desktop-controller/remote')
    await ctx.remote.$mount(remoteDesktopRemote)
  }
  new ClientRemoteDesktops(ctx, ctx.get('remote.remoteDesktop') as RemoteDesktopRemote)
}
