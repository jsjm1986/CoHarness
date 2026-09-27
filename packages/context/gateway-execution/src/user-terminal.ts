/** Creator-bound terminal grants follow the existing Gateway revocation stream. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import { readGatewayResponseJson } from '@deepseek-ai/dsh-gateway-runtime'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TerminalAuthority, TerminalCreatorId, UserTerminalAuthorization } from '@deepseek-ai/dsh-api-terminal-controller'

interface Grant {
  readonly key: string
  readonly id: string
  readonly sessionId: SessionId
  readonly userId: number
  readonly lifetime: AbortController
  references: number
}

/** No browser assertion is kept after admission; runtime-bound grants support later revalidation. */
export class GatewayUserTerminalAuthorization implements UserTerminalAuthorization {
  private readonly lifetime = new AbortController()
  private readonly grants = new Map<string, Grant>()
  private revision = 0

  constructor(private readonly runtime: Pick<GatewayRuntime, 'interactive' | 'request' | 'identity' | 'organization'>,
    private readonly available: () => boolean) {}

  /**
   * Validate the actual interactive user and borrow the current creator grant.
   * @param sessionId - target Session, including a terminal retained outside the active pane.
   * @param signal - request cancellation.
   * @returns a disposable borrow; owners retain a separate reference through cleanup.
   */
  async authorize(sessionId: SessionId, signal: AbortSignal): Promise<TerminalAuthority> {
    const principal = this.runtime.interactive(), revision = this.revision
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    if (!this.available() || principal === undefined || principal.claims.purpose !== undefined
      || principal.claims.expiresAt <= Date.now()) throw denied()
    const response = await this.runtime.request('/internal/runtime/execution/terminal-authorize', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }), principal, signal: combined,
    })
    if (!response.ok) { await response.body?.cancel(); throw denied() }
    const value: unknown = await readGatewayResponseJson(response, undefined, combined)
    combined.throwIfAborted()
    if (!this.available() || revision !== this.revision || !isRecord(value) || value.userId !== principal.claims.user.id
      || typeof value.grantId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.grantId)) throw denied()
    const key = JSON.stringify([sessionId, value.userId])
    let grant = this.grants.get(key)
    if (grant?.id !== value.grantId) {
      grant?.lifetime.abort(denied())
      grant = { key, id: value.grantId, sessionId, userId: value.userId, lifetime: new AbortController(), references: 0 }
      this.grants.set(key, grant)
    }
    grant.lifetime.signal.throwIfAborted()
    const borrowed = this.retain(grant), retained = grant
    const creator = JSON.stringify([
      this.runtime.organization, this.runtime.identity.kind, this.runtime.identity.id, value.userId,
    ]) as TerminalCreatorId
    return { creator,
      creatorUserId: value.userId, signal: grant.lifetime.signal, retain: () => this.retain(retained),
      [Symbol.dispose]: () => { borrowed[Symbol.dispose]() } }
  }

  /**
   * Admit only a short-lived management assertion after checking the current database role.
   * @param signal - administrator request cancellation.
   * @returns after the Gateway confirms metadata/termination authority.
   */
  async administrator(signal: AbortSignal): Promise<void> {
    const principal = this.runtime.interactive()
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    if (principal === undefined || principal.claims.purpose !== 'terminal-admin'
      || principal.claims.user.role !== 'admin' || principal.claims.expiresAt <= Date.now()) throw denied()
    const response = await this.runtime.request('/internal/runtime/terminal-management/authorize', {
      method: 'POST', principal, signal: combined,
    })
    if (response.status !== 204) { await response.body?.cancel(); throw denied() }
    combined.throwIfAborted()
  }

  /**
   * Revalidate affected owners or cancel all grants when updates become unavailable.
   * @param subject - invalidated user/project; absence means the watch was interrupted.
   * @returns after rechecks; the terminal controller separately awaits process teardown.
   */
  async invalidate(subject?: { userId?: number; projectId?: number }): Promise<void> {
    if (subject?.projectId !== undefined && (this.runtime.identity.kind !== 'project' || this.runtime.identity.id !== subject.projectId)) return
    this.revision++
    await Promise.all([...this.grants.values()].map(async (grant) => {
      if (subject?.userId !== undefined && grant.userId !== subject.userId) return
      try {
        if (subject === undefined || !this.available()) throw denied()
        const response = await this.runtime.request('/internal/runtime/execution/terminal-check', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: grant.sessionId, grantId: grant.id }), signal: this.lifetime.signal,
        })
        if (!response.ok) { await response.body?.cancel(); throw denied() }
        const result: unknown = await readGatewayResponseJson(response, undefined, this.lifetime.signal)
        if (!isRecord(result) || result.userId !== grant.userId) throw denied()
      } catch {
        // Unavailable current authorization ends the grant; it never resumes old processes.
        grant.lifetime.abort(denied())
        if (this.grants.get(grant.key) === grant) this.grants.delete(grant.key)
      }
    }))
  }

  /** Stop admitting work and revoke all retained process owners. */
  dispose(): void {
    this.lifetime.abort(denied())
    for (const grant of this.grants.values()) grant.lifetime.abort(denied())
    this.grants.clear()
  }

  private retain(grant: Grant): Disposable {
    grant.references++
    let released = false
    return { [Symbol.dispose]: () => {
      if (released) return
      released = true
      if (--grant.references === 0 && this.grants.get(grant.key) === grant) this.grants.delete(grant.key)
    } }
  }
}

function denied(): RemoteError<'terminal/forbidden'> {
  return new RemoteError('terminal/forbidden', 'User terminal access requires current user qualification and writable project authorization.', {})
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
