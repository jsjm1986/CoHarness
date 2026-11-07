/** Gateway-owned authority for already admitted event WebSockets. */
import type { StreamSessionQualification } from './auth.ts'
import type { GatewayRequestContext } from './server.ts'
import type { GatewayPrincipalClaims, GatewayPrincipalSigner, PrincipalScope } from './principal.ts'

/** Runtime identity verified by the existing private bearer-token admission. */
export interface StreamLeaseRuntime {
  target: { kind: 'user' | 'project'; id: number }
  generation: number
}

/** One bounded batch; ids identify existing sockets and never grant authority. */
export interface StreamPrincipalRenewals {
  version: 1
  leases: Array<{ leaseId: string; status: 'denied' } | { leaseId: string; status: 'renewed'; assertion: string }>
}

interface Entry {
  id: string
  token: string
  context: GatewayRequestContext
  claims: GatewayPrincipalClaims
  expiresAt: number
  signal: AbortSignal
  cancel: () => void
  release: () => void
  timer: NodeJS.Timeout | undefined
}

/** Malformed private renewal requests are refused before any qualification read. */
export class StreamPrincipalRequestError extends Error {
  readonly code = 'invalid-stream-principal-request'
}

/** Compare every signed identity and scope fact while excluding freshness fields. */
function identity(claims: Pick<GatewayPrincipalClaims, 'organization' | 'user' | 'scope' | 'runtime' | 'purpose'>): string {
  return JSON.stringify([claims.organization, claims.user, claims.scope, claims.runtime, claims.purpose ?? null])
}

/** Socket-owned registry; private renewal cannot manufacture a new browser connection. */
export class StreamPrincipalLeases {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  /**
   * @param options - signer, finite batch limit and current authority checks; no caller-supplied identity is accepted.
   */
  constructor(private readonly options: {
    signer: GatewayPrincipalSigner
    maxBatchSize: number
    synchronize: () => Promise<void>
    qualify: (token: string, context: GatewayRequestContext) => Promise<(StreamSessionQualification & { scope: PrincipalScope }) | null>
  }) {}

  /**
   * Register one successfully qualified event socket before proxying its upgrade.
   * @param input - initial signed assertion, original login and socket-owned cancellation.
   */
  register(input: {
    assertion: string; token: string; context: GatewayRequestContext; signal: AbortSignal; cancel: () => void
  }): void {
    if (this.closed || input.signal.aborted) return
    const claims = this.options.signer.verify(input.assertion)
    if (claims.purpose !== undefined || claims.expiresAt - claims.issuedAt > 30_000) throw new Error('event principal is not short-lived browser authority')
    if (this.entries.has(claims.nonce)) throw new Error('event principal nonce is already registered')
    const entry: Entry = {
      id: claims.nonce, token: input.token, context: structuredClone(input.context), claims,
      expiresAt: claims.expiresAt, signal: input.signal, cancel: input.cancel, timer: undefined,
      release: () => {
        clearTimeout(entry.timer)
        entry.signal.removeEventListener('abort', entry.release)
        if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
      },
    }
    this.entries.set(entry.id, entry)
    entry.signal.addEventListener('abort', entry.release, { once: true })
    if (entry.signal.aborted) entry.release()
    else this.arm(entry)
  }

  /**
   * Revalidate registered sockets using their original login, never runtime-selected user facts.
   * @param runtime - authenticated current runtime token's owner and generation.
   * @param value - untrusted JSON batch containing only registered connection ids.
   * @param runtimeCurrent - recheck the bearer token and generation after asynchronous qualification.
   * @returns signed short-lived replacements or an individual denial for each requested id.
   */
  async renew(runtime: StreamLeaseRuntime, value: unknown, runtimeCurrent: () => Promise<boolean>): Promise<StreamPrincipalRenewals> {
    const request = value as { version?: unknown; leaseIds?: unknown } | null
    if (request === null || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => key !== 'version' && key !== 'leaseIds')
      || request.version !== 1 || !Array.isArray(request.leaseIds) || request.leaseIds.length === 0
      || request.leaseIds.length > this.options.maxBatchSize
      || !request.leaseIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)
      || new Set(request.leaseIds).size !== request.leaseIds.length) {
      throw new StreamPrincipalRequestError('invalid event connection renewal batch')
    }
    const ids = request.leaseIds as string[]
    const captured = ids.map(id => this.entries.get(id))
    await this.options.synchronize()
    const qualified = new Map<string, (StreamSessionQualification & { scope: PrincipalScope }) | null>()
    for (const entry of captured) {
      if (!this.live(entry, runtime)) continue
      const key = JSON.stringify([entry.token, identity(entry.claims)])
      if (!qualified.has(key)) qualified.set(key, await this.options.qualify(entry.token, entry.context))
    }
    const currentRuntime = await runtimeCurrent()
    await this.options.synchronize()
    const leases: StreamPrincipalRenewals['leases'] = []
    for (let index = 0; index < ids.length; index++) {
      const leaseId = ids[index]!
      const entry = captured[index]
      if (!this.live(entry, runtime)) { leases.push({ leaseId, status: 'denied' }); continue }
      if (!currentRuntime) {
        entry.release(); entry.cancel()
        leases.push({ leaseId, status: 'denied' }); continue
      }
      const current = qualified.get(JSON.stringify([entry.token, identity(entry.claims)]))
      if (current === undefined || current === null || current.expiresAt <= Date.now()
        || identity({ ...entry.claims, user: {
          id: current.user.id, username: current.user.username, displayName: current.user.displayName, role: current.user.role,
        }, scope: current.scope }) !== identity(entry.claims)) {
        entry.release()
        entry.cancel()
        leases.push({ leaseId, status: 'denied' })
        continue
      }
      const assertion = this.options.signer.issueStream({
        user: current.user, scope: current.scope, runtime: entry.claims.runtime,
      }, current.expiresAt)
      const replacement = this.options.signer.verify(assertion)
      entry.expiresAt = replacement.expiresAt
      this.arm(entry)
      leases.push({ leaseId, status: 'renewed', assertion })
    }
    return { version: 1, leases }
  }

  /** Cancel all sockets and forget every login when the proxy owner closes. */
  close(): void {
    this.closed = true
    for (const entry of [...this.entries.values()]) { entry.release(); entry.cancel() }
  }

  /**
   * Count live event-socket registrations without identity labels.
   * @returns the number of currently owned event sockets.
   */
  get size(): number { return this.entries.size }

  private live(entry: Entry | undefined, runtime: StreamLeaseRuntime): entry is Entry {
    return entry !== undefined && !this.closed && !entry.signal.aborted
      && this.entries.get(entry.id) === entry && entry.expiresAt > Date.now()
      && entry.claims.runtime.kind === runtime.target.kind && entry.claims.runtime.id === runtime.target.id
      && entry.claims.runtime.generation === runtime.generation
  }

  private arm(entry: Entry): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.release()
      entry.cancel()
    }, Math.max(0, entry.expiresAt - Date.now()))
    entry.timer.unref()
  }
}
