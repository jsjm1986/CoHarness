/** Current-node terminal inventory and termination without output or input forwarding. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { UserRow } from './auth.ts'
import { RuntimeLeaseUnavailableError, type RuntimeTarget } from './instances.ts'
import { PRINCIPAL_HEADER, type GatewayPrincipalSigner } from './principal.ts'
import type { GatewayDeps } from './server.ts'
import { readResponseJson } from './response-budget.ts'

const terminal = z.object({
  ownerId: z.uuid(), sessionId: z.string().min(1), id: z.string().regex(/^[\w-]{1,128}$/u),
  creatorUserId: z.number().int().positive().optional(),
  state: z.enum(['starting', 'running', 'exited', 'failed', 'stopping']),
}).strict()
export type AdminTerminal = z.infer<typeof terminal>
export interface AdminTerminalInventory { nodeId: string; target: RuntimeTarget; generation: number | null; terminals: AdminTerminal[] }

/** Stable public diagnostics exclude runtime response bodies and process details. */
export class TerminalManagementError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 502 | 503, message: string) { super(message) }
}

/** Metadata operations target only an already running instance on this Gateway's node. */
export class GatewayTerminalManagement {
  constructor(private readonly deps: Pick<GatewayDeps, 'users' | 'projects' | 'instances' | 'cfg'>,
    private readonly signer: GatewayPrincipalSigner, private readonly nodeId: string) {}

  /**
   * Read current process metadata without starting an idle runtime.
   * @param admin - authenticated administrator.
   * @param target - account or project runtime on the current node.
   * @returns bounded inventory and the exact generation required for closing.
   */
  async list(admin: UserRow, target: RuntimeTarget): Promise<AdminTerminalInventory> {
    await this.administrator(admin)
    await this.owner(target)
    if (!await this.deps.instances.isLive(target)) return { nodeId: this.nodeId, target, generation: null, terminals: [] }
    const generation = await this.deps.instances.generationOf(target)
    const value = await this.invoke(admin, target, generation, 'adminList', {})
    const result = z.array(terminal).safeParse(value)
    if (!result.success) throw new TerminalManagementError(502, 'invalid terminal inventory')
    return { nodeId: this.nodeId, target, generation, terminals: result.data }
  }

  /**
   * Close a reviewed inventory entry in the same node and runtime generation.
   * @param admin - authenticated administrator.
   * @param target - selected account or project runtime.
   * @param value - node, generation and exact owner/terminal identities from the inventory.
   * @returns after the runtime confirms process cleanup; failure remains visible and retryable.
   */
  async close(admin: UserRow, target: RuntimeTarget, value: unknown): Promise<void> {
    const result = z.object({ nodeId: z.string(), generation: z.number().int().positive(), ownerId: z.uuid(), id: terminal.shape.id }).strict().safeParse(value)
    if (!result.success) throw new TerminalManagementError(400, 'invalid terminal close request')
    if (result.data.nodeId !== this.nodeId) throw new TerminalManagementError(409, 'terminal inventory belongs to another node')
    await this.administrator(admin)
    await this.owner(target)
    await this.invoke(admin, target, result.data.generation, 'adminClose', { ownerId: result.data.ownerId, id: result.data.id })
  }

  private async administrator(admin: UserRow): Promise<void> {
    const current = await this.deps.users.getById(admin.id)
    if (admin.role !== 'admin' || current?.role !== 'admin' || current.status !== 'active') throw new TerminalManagementError(403, 'administrator permission required')
  }

  private async owner(target: RuntimeTarget): Promise<string> {
    const owner = target.kind === 'user' ? await this.deps.users.getById(target.id) : await this.deps.projects.getById(target.id)
    if (owner === null) throw new TerminalManagementError(404, 'terminal runtime owner not found')
    return target.kind === 'project' && 'name' in owner ? owner.name : ''
  }

  private async invoke(admin: UserRow, target: RuntimeTarget, generation: number, method: 'adminList' | 'adminClose', args: object): Promise<unknown> {
    const instances = this.deps.instances
    if (!await instances.isLive(target) || await instances.generationOf(target) !== generation) throw new TerminalManagementError(409, 'terminal runtime changed; reload inventory')
    if (instances.operationRef === undefined) throw new TerminalManagementError(503, 'terminal runtime leases unavailable')
    try { await instances.operationRef(target, 1, generation) } catch (error) {
      if (error instanceof RuntimeLeaseUnavailableError) throw new TerminalManagementError(409, 'terminal runtime changed; reload inventory')
      throw new TerminalManagementError(503, 'terminal runtime lease unavailable')
    }
    try {
      const projectName = await this.owner(target)
      const authority = `127.0.0.1:${String(await instances.portOf(target))}`
      const assertion = this.signer.issue({ user: admin, runtime: { ...target, generation }, purpose: 'terminal-admin',
        scope: target.kind === 'user' ? { kind: 'personal' } : { kind: 'project', projectId: target.id, projectName, mode: 'ro' } })
      const rpcId = randomUUID(), endpoint = `terminal/${method}`
      const response = await fetch(`http://${authority}/api/${endpoint}`, {
        method: 'POST', headers: { host: authority, 'content-type': 'application/json', [PRINCIPAL_HEADER]: assertion },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), signal: AbortSignal.timeout(this.deps.cfg.readinessTimeoutMs),
      })
      if (!response.ok) { await response.body?.cancel(); throw new TerminalManagementError(502, 'terminal runtime unavailable') }
      const value: unknown = await readResponseJson(response, this.deps.cfg.upstreamResponseLimitBytes)
      const parsed = z.object({ rpcId: z.literal(rpcId), result: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), value: z.unknown().optional() }),
        z.object({ ok: z.literal(false), error: z.object({ code: z.string() }).passthrough() }),
      ]) }).safeParse(value)
      if (!parsed.success) throw new TerminalManagementError(502, 'invalid terminal runtime response')
      if (!parsed.data.result.ok) throw new TerminalManagementError(parsed.data.result.error.code === 'terminal/forbidden' ? 403 : 502, 'terminal management refused')
      if (!await instances.isLive(target) || await instances.generationOf(target) !== generation) throw new TerminalManagementError(409, 'terminal runtime changed; reload inventory')
      return parsed.data.result.value
    } catch (error) {
      if (error instanceof TerminalManagementError) throw error
      throw new TerminalManagementError(503, 'terminal runtime communication failed')
    } finally {
      try { await instances.operationRef(target, -1, generation) } catch {
        throw new TerminalManagementError(503, 'terminal runtime lease cleanup failed')
      }
    }
  }
}
