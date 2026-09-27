/** Runtime-side resolution and revocation of administrator-registered SSH targets. */
import { readGatewayResponseJson, type GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import type { SshAuthorization, SshInvalidationSubject, SshResolvedTarget } from '@deepseek-ai/dsh-ssh'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

const resolvedConfig = z.object({
  host: z.string().min(1), node: z.string().min(1), helper: z.string().min(1),
  helperHash: z.string().regex(/^[0-9a-f]{64}$/u), workspace: z.string().min(1),
  bootstrapPath: z.string().min(1).optional(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  passwordRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).optional(),
  requestTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
  maxFrameBytes: z.number().int().positive().optional(),
  maxPending: z.number().int().positive().optional(),
  leaseMs: z.number().int().positive().optional(),
}).strict().refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined))

/**
 * Resolve registered targets through the Gateway only while the authorization
 * watch is live; mounted connections learn revocation through {@link onInvalidated}.
 */
export class GatewaySshAuthorization implements SshAuthorization {
  private readonly lifetime = new AbortController()
  private readonly listeners = new Set<(subject: SshInvalidationSubject) => void>()
  private readonly grants = new Set<{ userId: number; projectId?: number; lifetime: AbortController }>()
  private revision = 0

  constructor(private readonly runtime: Pick<GatewayRuntime, 'interactive' | 'request' | 'identity'>,
    private readonly available: () => boolean) {}

  /**
   * Resolve one registered target for the live interactive caller.
   * @param targetId - administrator-registered target's public id.
   * @param signal - caller cancellation.
   * @returns the caller identity and the released connection configuration.
   */
  async resolve(targetId: number, signal?: AbortSignal): Promise<SshResolvedTarget> {
    const principal = this.runtime.interactive(), revision = this.revision
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    if (!this.available() || principal === undefined || principal.claims.purpose !== undefined
      || principal.claims.expiresAt <= Date.now()) throw denied()
    const response = await this.runtime.request('/internal/runtime/ssh/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId }), principal, signal: combined,
    })
    if (!response.ok) { await response.body?.cancel(); throw denied() }
    const value: unknown = await readGatewayResponseJson(response, undefined, combined)
    combined.throwIfAborted()
    const config = isRecord(value) ? resolvedConfig.safeParse(value.config) : undefined
    if (!this.available() || revision !== this.revision || config === undefined || !config.success || !isRecord(value)
      || value.userId !== principal.claims.user.id) throw denied()
    const identity = this.runtime.identity
    const grant = {
      userId: principal.claims.user.id,
      ...(identity.kind === 'project' ? { projectId: identity.id } : {}),
      lifetime: new AbortController(),
    }
    this.grants.add(grant)
    grant.lifetime.signal.addEventListener('abort', () => { this.grants.delete(grant) }, { once: true })
    return {
      userId: principal.claims.user.id,
      config: connectionConfig(config.data),
      signal: grant.lifetime.signal,
      release: () => { grant.lifetime.abort() },
    }
  }

  /**
   * Subscribe to access revocation narrowed by the watch stream.
   * @param listener - receives the affected subject; empty means every mount.
   * @returns unsubscription.
   */
  onInvalidated(listener: (subject: SshInvalidationSubject) => void): Disposable {
    this.listeners.add(listener)
    return { [Symbol.dispose]: () => { this.listeners.delete(listener) } }
  }

  /**
   * Fan one watch-stream invalidation out to mounted-connection owners.
   * @param subject - invalidated user or project; absence revokes everything.
   */
  invalidate(subject?: SshInvalidationSubject): void {
    this.revision++
    const narrowed = subject === undefined ? {} : subject
    for (const grant of [...this.grants]) {
      if (narrowed.userId !== undefined && grant.userId !== narrowed.userId) continue
      if (narrowed.projectId !== undefined && grant.projectId !== narrowed.projectId) continue
      grant.lifetime.abort(denied())
    }
    for (const listener of [...this.listeners]) listener(narrowed)
  }

  /** Stop admitting resolutions and notify owners that every mount lost authority. */
  dispose(): void {
    this.lifetime.abort(denied())
    for (const grant of [...this.grants]) grant.lifetime.abort(denied())
    for (const listener of [...this.listeners]) listener({})
    this.listeners.clear()
  }
}

function denied(): RemoteError<'ssh/forbidden'> {
  return new RemoteError('ssh/forbidden', 'SSH targets require current user qualification and project sharing.', {})
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** exactOptionalPropertyTypes rejects wire-parsed `key: undefined`; absent means absent. */
function connectionConfig(value: z.infer<typeof resolvedConfig>): SshResolvedTarget['config'] {
  return {
    host: value.host, node: value.node, helper: value.helper, helperHash: value.helperHash,
    workspace: value.workspace,
    ...(value.bootstrapPath === undefined || value.bootstrapHash === undefined
      ? {} : { bootstrapPath: value.bootstrapPath, bootstrapHash: value.bootstrapHash }),
    ...(value.passwordRef === undefined ? {} : { passwordRef: value.passwordRef }),
    ...(value.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: value.requestTimeoutMs }),
    ...(value.maxFrameBytes === undefined ? {} : { maxFrameBytes: value.maxFrameBytes }),
    ...(value.maxPending === undefined ? {} : { maxPending: value.maxPending }),
    ...(value.leaseMs === undefined ? {} : { leaseMs: value.leaseMs }),
  }
}
