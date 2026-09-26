/** Administrator-only forwarding to the exact current-node profile generation. */
import { z } from 'zod'
import type { UserRow } from './auth.ts'
import { RuntimeLeaseUnavailableError, type RuntimeTarget } from './instances.ts'
import { PRINCIPAL_HEADER, type GatewayPrincipalSigner } from './principal.ts'
import type { GatewayDeps } from './server.ts'

const targetSchema = z.object({ kind: z.enum(['user', 'project']), id: z.number().int().positive() }).strict()
const invocationSchema = z.object({
  target: targetSchema, nodeId: z.string().min(1), generation: z.number().int().positive(), rpcId: z.uuid(),
  endpoint: z.enum(['settings.describe', 'settings.mutate', 'pluginInventory/list', 'pluginManager/listPlugins', 'pluginManager/listBundles', 'pluginManager/inspect',
    'pluginManager/setPluginEnabled', 'pluginManager/setBundleEnabled', 'pluginManager/installBundleStream',
    'pluginManager/cancelInstall', 'pluginManager/removeBundle']),
  args: z.record(z.string(), z.unknown()),
}).strict()

export interface PluginManagementTarget { nodeId: string; target: RuntimeTarget; generation: number | null }
export class PluginManagementError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 502 | 503, message: string) { super(message) }
}

/** Uses the runtime's generated validation and upstream manager; never starts an idle instance. */
export class GatewayPluginManagement {
  constructor(private readonly deps: Pick<GatewayDeps, 'users' | 'projects' | 'instances' | 'cfg'>,
    private readonly signer: GatewayPrincipalSigner, private readonly nodeId: string) {}

  /** Bind the selected running profile before showing actions; stopped instances stay stopped. */
  async target(admin: UserRow, input: unknown): Promise<PluginManagementTarget> {
    const parsed = targetSchema.safeParse(input)
    if (!parsed.success) throw new PluginManagementError(400, 'invalid plugin management target')
    await this.authorize(admin, parsed.data)
    const generation = await this.deps.instances.isLive(parsed.data) ? await this.deps.instances.generationOf(parsed.data) : null
    return { nodeId: this.nodeId, target: parsed.data, generation }
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
      try { await instances.operationRef(target, -1, generation) } catch {
        throw new PluginManagementError(503, 'profile operation lease cleanup failed')
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
    return target.kind === 'project' && 'name' in owner ? owner.name : ''
  }
}
