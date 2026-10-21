/** Human identity and administrator-role resolution for remote-desktop operations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-execution-authority'
import type {} from '@deepseek-ai/dsh-gateway-runtime'
import type { RemoteDesktopActor } from '@deepseek-ai/dsh-remote-desktop'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Resolve the authenticated human for remote-desktop calls, retaining
 * standalone local permissions. Managed deployments read the request's
 * verified Gateway principal directly: the administrator-issued grant file is
 * the product permission, so no user-terminal grant is required. Callers
 * without an interactive principal — agent-driven or restricted-purpose
 * requests — fail closed.
 */
export class RemoteDesktopAccess {
  private managed = false

  constructor(private readonly ctx: Context) {}

  /**
   * Resolve the caller's actor from the request's verified principal.
   * @param signal - cancellation before authorization completes.
   * @returns the authenticated actor; the standalone local operator is an administrator.
   */
  actor(signal: AbortSignal): RemoteDesktopActor {
    signal.throwIfAborted()
    this.managed ||= this.ctx.get('executionAuthorityRequired') === true || this.ctx.get('executionAuthority') !== undefined
    if (!this.managed) return { principal: 'local-operator', admin: true }
    const claims = this.ctx.get('gatewayRuntime')?.interactive()?.claims
    if (claims === undefined || claims.purpose !== undefined || claims.expiresAt <= Date.now()) {
      throw new RemoteError('remote-desktop/forbidden', 'Remote-desktop access requires an authenticated interactive user.', {})
    }
    return { principal: claims.user.username, admin: claims.user.role === 'admin' }
  }
}
