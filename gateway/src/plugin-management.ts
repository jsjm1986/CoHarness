/** Administrator-only forwarding to the exact current-node profile generation. */
import { join } from 'node:path'
import { z } from 'zod'
import type { UserRow } from './auth.ts'
import { RuntimeLeaseUnavailableError, type RuntimeTarget } from './instances.ts'
import { PRINCIPAL_HEADER, type GatewayPrincipalSigner } from './principal.ts'
import { parseDesiredState, PluginStateError, type PluginDesiredState } from './plugin-state.ts'
import type { GatewayDeps } from './server.ts'

const targetSchema = z.object({ kind: z.enum(['user', 'project']), id: z.number().int().positive() }).strict()
const stateWriteSchema = z.object({
  target: targetSchema,
  revision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),
  state: z.unknown().nullable(),
}).strict()
const invocationSchema = z.object({
  target: targetSchema, nodeId: z.string().min(1), generation: z.number().int().positive(), rpcId: z.uuid(),
  endpoint: z.enum(['settings.describe', 'settings.mutate', 'pluginInventory/list', 'pluginManager/listPlugins', 'pluginManager/listBundles', 'pluginManager/inspect',
    'pluginManager/setPluginEnabled', 'pluginManager/setBundleEnabled', 'pluginManager/installBundleStream',
    'pluginManager/cancelInstall', 'pluginManager/removeBundle', 'pluginManager/registries', 'pluginManager/waitForInstall',
    'pluginRegistryProbe/fastest']),
  args: z.record(z.string(), z.unknown()),
}).strict()

export interface PluginManagementTarget { nodeId: string; target: RuntimeTarget; generation: number | null }
/** Offline-capable desired-state view: saved row, applied marker, and the files' current expression. */
export interface PluginManagementState {
  revision: string
  state: PluginDesiredState | null
  appliedRevision: string
  generation: number | null
  observed: PluginDesiredState | null
}
export class PluginManagementError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 502 | 503, message: string) { super(message) }
}

/** Deadline for the parallel registry pings and lifetime of a winning registry or unavailable result. */
const REGISTRY_PROBE_TIMEOUT_MS = 1500
const REGISTRY_PROBE_CACHE_TTL_MS = 300_000
/** The public registries the probe compares, as the install dialog offers them. */
const REGISTRY_PROBE_ENDPOINTS = ['https://registry.npmjs.org/-/ping', 'https://registry.npmmirror.com/-/ping']

/** Uses the runtime's generated validation and upstream manager; never starts an idle instance. */
export class GatewayPluginManagement {
  /** Process-local registry probe state shared by every administrator's dialog. */
  private probePending: Promise<string | null> | undefined
  private probeCached: { registry: string | null; expiresAt: number } | undefined

  constructor(private readonly deps: Pick<GatewayDeps, 'users' | 'projects' | 'instances' | 'cfg' | 'pluginState'>,
    private readonly signer: GatewayPrincipalSigner, private readonly nodeId: string) {}

  /**
   * Race the public registry pings; the manager dialog uses the winner to preselect a mirror
   * when pnpm's own configuration names npm's official registry. Concurrent readers share one
   * probe; a winner cancels and awaits the loser; results are cached.
   * @returns the first registry with a successful response, or null when neither responds successfully.
   */
  private fastestRegistry(): Promise<string | null> {
    if (this.probeCached !== undefined && this.probeCached.expiresAt > Date.now()) {
      return Promise.resolve(this.probeCached.registry)
    }
    this.probePending ??= this.probeRegistries().finally(() => { this.probePending = undefined })
    return this.probePending
  }

  private async probeRegistries(): Promise<string | null> {
    const finished = new AbortController()
    const signal = AbortSignal.any([finished.signal, AbortSignal.timeout(REGISTRY_PROBE_TIMEOUT_MS)])
    const requests = REGISTRY_PROBE_ENDPOINTS.map(async endpoint => ({
      registry: new URL('/', endpoint).href,
      response: await fetch(endpoint, { signal, redirect: 'error' }),
    }))
    const successful = requests.map(async (request) => {
      const { registry, response } = await request
      if (!response.ok) throw new Error(`Registry ping returned HTTP ${response.status}`)
      return registry
    })
    let registry: string | null
    try {
      registry = await Promise.any(successful)
    } catch {
      registry = null
    } finally {
      finished.abort()
      const responses = await Promise.allSettled(requests)
      await Promise.allSettled(responses.map(async (result) => {
        if (result.status === 'fulfilled') await result.value.response.body?.cancel()
      }))
    }
    this.probeCached = { registry, expiresAt: Date.now() + REGISTRY_PROBE_CACHE_TTL_MS }
    return registry
  }

  /** Bind the selected running profile before showing actions; stopped instances stay stopped. */
  async target(admin: UserRow, input: unknown): Promise<PluginManagementTarget> {
    const parsed = targetSchema.safeParse(input)
    if (!parsed.success) throw new PluginManagementError(400, 'invalid plugin management target')
    await this.authorize(admin, parsed.data)
    const generation = await this.deps.instances.isLive(parsed.data) ? await this.deps.instances.generationOf(parsed.data) : null
    return { nodeId: this.nodeId, target: parsed.data, generation }
  }

  /** The owner's runtime home, where the observed profile projection lives. */
  private async dshHomeFor(target: RuntimeTarget): Promise<string> {
    if (target.kind === 'project') return join(this.deps.cfg.projectRuntimesRoot, String(target.id), 'dsh')
    const owner = await this.deps.users.getById(target.id)
    if (owner === null) throw new PluginManagementError(404, 'profile runtime owner not found')
    return join(this.deps.cfg.usersRoot, owner.username, 'dsh')
  }

  /**
   * Read the target's saved desired state, the instance's applied marker, and
   * the composition the profile files currently express. Offline-safe: the
   * instance is never started for a state read.
   * @param admin - current authenticated administrator.
   * @param input - exact target coordinates.
   * @returns the complete desired-state view for the offline editor.
   */
  async state(admin: UserRow, input: unknown): Promise<PluginManagementState> {
    const parsed = targetSchema.safeParse(input)
    if (!parsed.success) throw new PluginManagementError(400, 'invalid plugin management target')
    await this.authorize(admin, parsed.data)
    const store = this.deps.pluginState
    if (store === undefined) throw new PluginManagementError(503, 'plugin state store unavailable')
    const [saved, appliedRevision, observed] = await Promise.all([
      store.get(parsed.data), store.applied(parsed.data), store.observed(await this.dshHomeFor(parsed.data)),
    ])
    const generation = await this.deps.instances.isLive(parsed.data) ? await this.deps.instances.generationOf(parsed.data) : null
    return { revision: saved.revision, state: saved.state, appliedRevision, generation, observed }
  }

  /**
   * Commit one desired-state revision under optimistic concurrency. Live
   * instances keep managing through invoke; this write applies on their next
   * start or reconciles through their next published change.
   * @param admin - current authenticated administrator.
   * @param input - target, observed revision, and the complete desired state (null clears it).
   * @returns the post-commit desired-state view.
   */
  async saveState(admin: UserRow, input: unknown): Promise<PluginManagementState> {
    const parsed = stateWriteSchema.safeParse(input)
    if (!parsed.success) throw new PluginManagementError(400, 'invalid plugin state request')
    await this.authorize(admin, parsed.data.target)
    const store = this.deps.pluginState
    if (store === undefined) throw new PluginManagementError(503, 'plugin state store unavailable')
    const state = parsed.data.state === null ? null : parseDesiredState(parsed.data.state)
    try {
      await store.set(parsed.data.target, state, parsed.data.revision)
    } catch (error) {
      if (error instanceof PluginStateError) throw new PluginManagementError(error.status === 500 ? 502 : error.status, error.message)
      throw error
    }
    return this.state(admin, { kind: parsed.data.target.kind, id: parsed.data.target.id })
  }

  /**
   * Forward one validated request with backpressure and an awaited generation lease.
   * @param admin - current authenticated administrator.
   * @param input - exact target, node, generation, method, arguments and correlation id.
   * @param signal - downstream lifetime; installation cancellation waits in the runtime.
   * @returns bounded response chunks, without retrying side effects after transport failure.
   */
  async *invoke(admin: UserRow, input: unknown, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const parsed = invocationSchema.safeParse(input)
    if (!parsed.success) throw new PluginManagementError(400, 'invalid plugin management request')
    const value = parsed.data, { target, generation } = value
    if (value.endpoint === 'settings.mutate' && (typeof value.args.expectedRevision !== 'number'
      || !Number.isSafeInteger(value.args.expectedRevision) || value.args.expectedRevision < 0)) {
      throw new PluginManagementError(400, 'profile configuration requires a valid expected revision')
    }
    if (value.nodeId !== this.nodeId) throw new PluginManagementError(409, 'plugin management target belongs to another node')
    const owner = await this.authorize(admin, target)
    const instances = this.deps.instances
    if (!await instances.isLive(target) || await instances.generationOf(target) !== generation) {
      throw new PluginManagementError(409, 'profile instance changed; reload before retrying')
    }
    if (value.endpoint === 'pluginRegistryProbe/fastest') {
      const registry = await this.fastestRegistry().catch(() => null)
      yield new TextEncoder().encode(JSON.stringify({ type: 'server-response', rpcId: value.rpcId, result: { ok: true, value: registry } }))
      return
    }
    if (instances.operationRef === undefined) throw new PluginManagementError(503, 'profile operation leases unavailable')
    try { await instances.operationRef(target, 1, generation) } catch (error) {
      throw new PluginManagementError(error instanceof RuntimeLeaseUnavailableError ? 409 : 503, 'profile operation lease unavailable')
    }
    const lifetime = new AbortController()
    const abort = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(this.deps.cfg.upstreamTimeoutMs)])
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      abort.throwIfAborted()
      const authority = `127.0.0.1:${String(await instances.portOf(target))}`
      const assertion = this.signer.issuePluginManagement({ user: admin, runtime: { ...target, generation },
        scope: target.kind === 'user' ? { kind: 'personal' } : { kind: 'project', projectId: target.id, projectName: owner, mode: 'ro' } }, this.deps.cfg.upstreamTimeoutMs)
      const streaming = value.endpoint === 'pluginManager/installBundleStream'
      const response = await fetch(`http://${authority}/api/${streaming ? '_stream/' : ''}${value.endpoint}`, {
        method: 'POST', headers: { host: authority, 'content-type': 'application/json', [PRINCIPAL_HEADER]: assertion },
        body: JSON.stringify({ type: 'client-request', rpcId: value.rpcId, method: value.endpoint, payload: value.endpoint.startsWith('settings.') ? value.args : { args: value.args } }), signal: abort,
      })
      const expectedType = streaming ? 'application/x-ndjson' : 'application/json'
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== expectedType || response.body === null) {
        await response.body?.cancel()
        throw new PluginManagementError(502, 'profile runtime refused the management request')
      }
      reader = response.body.getReader()
      let bytes = 0
      while (true) {
        const chunk = await reader.read()
        abort.throwIfAborted()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > this.deps.cfg.upstreamResponseLimitBytes) throw new PluginManagementError(502, 'profile response exceeds its byte budget')
        yield chunk.value
      }
      if (!await instances.isLive(target) || await instances.generationOf(target) !== generation) {
        throw new PluginManagementError(409, 'profile instance changed; reload before retrying')
      }
    } catch (error) {
      if (error instanceof PluginManagementError) throw error
      throw new PluginManagementError(503, 'profile operation interrupted; inspect its result before retrying')
    } finally {
      lifetime.abort()
      try { await reader?.cancel() } catch { /* An aborted or errored reader already reports the transport failure. */ }
      reader?.releaseLock()
      try { await instances.operationRef(target, -1, generation) } catch (error: unknown) {
        // A failed release stays released; report it without masking the
        // operation's own result or earlier failure.
        console.error('[gateway] profile operation lease release failed:', error)
      }
    }
  }

  private async authorize(admin: UserRow, target: RuntimeTarget): Promise<string> {
    const current = await this.deps.users.getById(admin.id)
    if (admin.role !== 'admin' || current?.role !== 'admin' || current.status !== 'active') {
      throw new PluginManagementError(403, 'administrator permission required')
    }
    const owner = target.kind === 'user' ? await this.deps.users.getById(target.id) : await this.deps.projects.getById(target.id)
    if (owner === null) throw new PluginManagementError(404, 'profile runtime owner not found')
    // The steward space mounts a fixed composition: a live mutation here could
    // restart the resident runtime it would be administered through.
    if (target.kind === 'project' && 'kind' in owner && owner.kind === 'steward') {
      throw new PluginManagementError(403, 'steward runtime composition is fixed')
    }
    return target.kind === 'project' && 'name' in owner ? owner.name : ''
  }
}
