/** Human identity and administrator-role resolution for remote-desktop operations. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-execution-authority'
import type { TerminalAuthority, TerminalCreatorId } from '@deepseek-ai/dsh-api-terminal-controller'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Resolve the authenticated human for remote-desktop calls, retaining
 * standalone local permissions. Managed deployments delegate to the shared
 * `userTerminalAuthorization` policy — the same interactive-human seam the
 * terminal controller uses — and fail closed when it is absent.
 */
export class RemoteDesktopAccess {
  private managed = false
  private readonly local: TerminalAuthority

  constructor(private readonly ctx: Context, lifetime: AbortSignal) {
    this.local = {
      creator: 'local-operator' as TerminalCreatorId,
      signal: lifetime,
      retain: () => ({ [Symbol.dispose]() {} }),
      [Symbol.dispose]() {},
    }
  }

  /**
   * Verify the caller's human authority on one Session.
   * @param sessionId - exact Session addressed by the operation.
   * @param signal - cancellation before authorization completes.
   * @returns a verified creator grant; absent managed policies fail closed.
   */
  async authorize(sessionId: SessionId, signal: AbortSignal): Promise<TerminalAuthority> {
    signal.throwIfAborted()
    this.managed ||= this.ctx.get('executionAuthorityRequired') === true || this.ctx.get('executionAuthority') !== undefined
    const policy = this.ctx.get('userTerminalAuthorization')
    if (this.managed && policy === undefined) {
      throw new RemoteError('remote-desktop/forbidden', 'An active user authorization policy is required.', {})
    }
    const authority = policy === undefined ? this.local : await policy.authorize(sessionId, signal)
    try {
      signal.throwIfAborted()
      authority.signal.throwIfAborted()
      return authority
    } catch (error) {
      authority[Symbol.dispose]()
      throw error
    }
  }

  /**
   * Whether the current caller holds administrator authority. Standalone
   * deployments treat the local operator as administrator; managed
   * deployments delegate to `userTerminalAdministration`.
   * @param signal - current request cancellation.
   * @returns true when the administrator check succeeds.
   */
  async administrator(signal: AbortSignal): Promise<boolean> {
    this.managed ||= this.ctx.get('executionAuthorityRequired') === true || this.ctx.get('executionAuthority') !== undefined
    if (!this.managed) return true
    const administration = this.ctx.get('userTerminalAdministration')
    if (administration === undefined) {
      throw new RemoteError('remote-desktop/forbidden', 'An active administrator policy is required.', {})
    }
    try {
      await administration.administrator(signal)
      return true
    } catch (error) {
      if (error instanceof RemoteError) return false
      throw error
    }
  }
}
