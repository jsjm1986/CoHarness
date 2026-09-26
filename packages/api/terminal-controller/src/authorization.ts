/** Verified human ownership and revocation for interactive terminals. */
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-execution-authority'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Organization and runtime-scoped identity of a terminal's human creator. */
export type TerminalCreatorId = Branded<'TerminalCreatorId'>

/** Authority lifetime independent of a browser request or output attachment. */
export interface TerminalAuthority extends Disposable {
  readonly creator: TerminalCreatorId
  /** Managed account identifier for administrator metadata; standalone Hosts omit it. */
  readonly creatorUserId?: number
  /** Revocation or policy disposal aborts every process created under this grant. */
  readonly signal: AbortSignal
  /** Retain this grant until an owned terminal group finishes cleanup. */
  retain(): Disposable
}

/** Managed deployments verify the interactive user and current writable scope. */
export interface UserTerminalAuthorization {
  /**
   * Authorize a real user gesture without inheriting model, Auto, or approval authority.
   * @param sessionId - exact target Session, including inactive history.
   * @param signal - request cancellation, distinct from the returned authority lifetime.
   * @returns creator identity and a grant cancelled on revocation.
   */
  authorize(sessionId: SessionId, signal: AbortSignal): Promise<TerminalAuthority>
}

/** Administrator access grants metadata and termination, never screen or input access. */
export interface UserTerminalAdministration {
  /**
   * Verify inventory and termination authority independently of terminal creation.
   * @param signal - current request cancellation.
   * @returns after current administrator role validation.
   */
  administrator(signal: AbortSignal): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User-terminal policy; mandatory once the runtime has been managed. */
    userTerminalAuthorization: UserTerminalAuthorization
    /** Current administrator authorization for metadata and explicit termination. */
    userTerminalAdministration: UserTerminalAdministration
  }
}

/** A controller remembers managed mode even when its authorizing plugin unloads. */
export class TerminalAccess {
  private managed = false
  private readonly local: TerminalAuthority
  constructor(private readonly ctx: Context, lifetime: AbortSignal) {
    this.local = { creator: 'local-operator' as TerminalCreatorId, signal: lifetime, retain: () => ({ [Symbol.dispose]() {} }), [Symbol.dispose]() {} }
  }

  /**
   * Resolve the current human authority, retaining standalone local permissions.
   * @param sessionId - exact Session addressed by the operation.
   * @param signal - cancellation before authorization completes.
   * @returns a verified creator grant; absent managed policies fail closed.
   */
  async authorize(sessionId: SessionId, signal: AbortSignal): Promise<TerminalAuthority> {
    signal.throwIfAborted()
    this.managed ||= this.ctx.get('executionAuthorityRequired') === true || this.ctx.get('executionAuthority') !== undefined
    const policy = this.ctx.get('userTerminalAuthorization')
    if (this.managed && policy === undefined) throw new RemoteError('terminal/forbidden', 'An active user-terminal authorization policy is required.', {})
    const authority = policy === undefined ? this.local : await policy.authorize(sessionId, signal)
    try {
      signal.throwIfAborted()
      authority.signal.throwIfAborted()
      return authority
    } catch (error) { authority[Symbol.dispose](); throw error }
  }
  /**
   * Validate metadata-only management without borrowing another creator's authority.
   * @param signal - current request cancellation.
   * @returns after current administrator permission is confirmed.
   */
  async administrator(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.managed ||= this.ctx.get('executionAuthorityRequired') === true || this.ctx.get('executionAuthority') !== undefined
    const policy = this.ctx.get('userTerminalAdministration')
    if (this.managed && policy === undefined) throw new RemoteError('terminal/forbidden', 'An active terminal administration policy is required.', {})
    await policy?.administrator(signal)
    signal.throwIfAborted()
  }

}
