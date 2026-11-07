/** Private local Node Agent setup; codes never enter public settings or process arguments. @module */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { loadNodeAgentConfig, type NodeAgentConfig } from './node-agent.ts'
import { nodeEnrollmentTokenSchema, nodeIdentitySchema } from './node-access.ts'
import { NodeConfigurationError, type NodeConfigurationMutationAuthority } from './node-config-store.ts'
import { runGatewayChildCommand } from './child-command.ts'
import type { GatewayConfig } from './config.ts'
import type { UserRow } from './auth.ts'
import type { Queryable } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { PostgresDeploymentTopology } from './deployment-topology.ts'

const recordSchema = z.object({ version: z.literal(1), revision: z.number().int().positive().safe(),
  organizationId: nodeIdentitySchema.shape.organizationId, nodeId: nodeIdentitySchema.shape.nodeId, centerUrl: z.string(), localGatewayUrl: z.string(),
  stateFile: z.string(), enrollmentToken: nodeEnrollmentTokenSchema.nullable() }).strict()
type Record = z.infer<typeof recordSchema>
const input = z.object({ revision: z.number().int().nonnegative().safe(), centerUrl: z.string().max(2048),
  enrollmentToken: nodeEnrollmentTokenSchema }).strict()

import type { NodeConnectionView } from './deployment-protocol.ts'
export type { NodeConnectionView } from './deployment-protocol.ts'

/** Resolve a stable private file independently of browser input. @param env - bootstrap environment. @returns local file path. */
export function nodeConnectionFile(env: NodeJS.ProcessEnv): string {
  return env.HGW_NODE_CONNECTION_FILE ?? join(env.HGW_STATE_ROOT ?? join(homedir(), '.harness-gateway'), 'node-connection.json')
}

async function read(file: string): Promise<Record | undefined> {
  let handle
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new NodeConfigurationError(409, 'node-connection-file-not-private')
    }
    const bytes = Buffer.alloc(8193)
    let length = 0
    while (length < bytes.length) {
      const next = await handle.read(bytes, length, bytes.length - length, length)
      if (next.bytesRead === 0) break
      length += next.bytesRead
    }
    if (length > 8192) throw new NodeConfigurationError(409, 'node-connection-file-too-large')
    try { return recordSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8'))) }
    catch (error) { throw new NodeConfigurationError(409, 'node-connection-file-invalid', { cause: error }) }
  } finally { await handle.close() }
}

async function write(file: string, record: Record, signal?: AbortSignal): Promise<void> {
  const bytes = JSON.stringify(record) + '\n'
  if (Buffer.byteLength(bytes) > 8192) throw new NodeConfigurationError(400, 'node-connection-file-too-large')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    signal?.throwIfAborted()
    await rename(temporary, file)
    const directory = await open(dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temporary, { force: true }) }
}

/**
 * Load the independent agent from owner-private setup, or its existing explicit environment.
 * @param env - installed service bootstrap environment.
 * @returns agent settings and a joined post-enrollment code-erasure action.
 */
export async function configuredNodeAgent(env: NodeJS.ProcessEnv): Promise<{ config: NodeAgentConfig; clearCode(): Promise<void> }> {
  const file = nodeConnectionFile(env), record = await read(file)
  if (record === undefined) return { config: loadNodeAgentConfig(env), clearCode: async () => {} }
  const config = loadNodeAgentConfig({ ...env, HGW_NODE_CENTER_URL: record.centerUrl,
    HGW_NODE_LOCAL_GATEWAY_URL: record.localGatewayUrl, HGW_NODE_AGENT_STATE_FILE: record.stateFile,
    HGW_NODE_ENROLLMENT_TOKEN: record.enrollmentToken ?? undefined })
  return { config: { ...config, expectedIdentity: { organizationId: record.organizationId, nodeId: record.nodeId } },
    clearCode: () => withFileLock(file, async () => {
      const current = await read(file)
      if (current?.revision === record.revision && current.enrollmentToken !== null) {
        await write(file, { ...current, enrollmentToken: null })
      }
    }, { waitMs: 0 }) }
}

/** Node-owned setup and fixed installed-service actions; no arbitrary commands or remote credentials are accepted. */
export class GatewayNodeConnection {
  private readonly file: string
  private readonly service: string
  constructor(private readonly context: PostgresRuntimeContext, private readonly cfg: GatewayConfig,
    private readonly environment: NodeJS.ProcessEnv, private readonly authority: NodeConfigurationMutationAuthority,
    private readonly topology: Pick<PostgresDeploymentTopology, 'read'>) {
    this.file = cfg.nodeConnectionFile
    this.service = process.platform === 'darwin'
      ? `${environment.HGW_LAUNCHD_DOMAIN ?? `gui/${process.getuid?.() ?? 0}`}/${environment.HGW_NODE_AGENT_LABEL ?? 'com.maycran.harness-node-agent'}`
      : environment.HGW_NODE_AGENT_SERVICE ?? 'harness-node-agent.service'
    if (/[\s\u0000-\u001f]/u.test(this.service)) throw new NodeConfigurationError(400, 'invalid-node-agent-service')
  }

  private async status(record: Record | undefined, query: Queryable): Promise<NodeConnectionView> {
    const attachment = (await query.query<{ attachment_state: string; revoked: boolean; live: boolean }>(
      `SELECT attachment_state,revoked_at IS NOT NULL revoked,COALESCE(lease_expires_at>clock_timestamp(),false) live
        FROM harness.node_agents WHERE organization_id=$1 AND node_id=$2`, [this.context.organizationId, this.context.nodeId])).rows[0]
    const connectionState: NodeConnectionView['connectionState'] = attachment === undefined || attachment.attachment_state === 'detached' ? 'independent'
      : attachment.revoked ? 'revoked' : attachment.attachment_state === 'pending' ? 'pending' : attachment.live ? 'connected' : 'disconnected'
    return { nodeId: this.context.nodeId as import('./runtime-catalog.ts').RuntimeNodeId, revision: record?.revision ?? 0, configured: record !== undefined,
      centerUrl: record?.centerUrl ?? null, localGatewayUrl: record?.localGatewayUrl ?? `http://127.0.0.1:${this.cfg.port}`,
      enrollmentPending: record?.enrollmentToken !== null && record !== undefined,
      originReady: record === undefined || this.cfg.publicOrigins.includes(record.centerUrl), service: this.service, connectionState }
  }

  /** Read credential-free status under current administrator authority. @param actor - authenticated administrator. */
  view(actor: UserRow): Promise<NodeConnectionView> {
    return this.authority.authorize(actor.id, async query => this.status(await read(this.file), query))
  }

  /**
   * Save one reviewed enrollment, retaining the computer's existing identity and private data.
   * @param actor - current administrator.
   * @param value - revision, expected center origin and one-time code.
   * @returns credential-free status; the code is stored only in the private setup file until enrolled.
   */
  save(actor: UserRow, value: unknown): Promise<NodeConnectionView> {
    const parsed = input.safeParse(value)
    if (!parsed.success) throw new NodeConfigurationError(400, 'node-connection-invalid-request')
    return this.authority.run(actor.id, async (signal, _epoch, query) => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      return withFileLock(this.file, async () => {
        const current = await read(this.file)
        if ((current?.revision ?? 0) !== parsed.data.revision) throw new NodeConfigurationError(409, 'node-connection-revision-conflict')
        const topology = await this.topology.read(query)
        const candidate = loadNodeAgentConfig({ HGW_NODE_CENTER_URL: parsed.data.centerUrl, HGW_NODE_ENROLLMENT_TOKEN: parsed.data.enrollmentToken })
        if (topology.mode !== 'multi' || topology.primary?.origin !== candidate.centerUrl || topology.primary.nodeId === this.context.nodeId) {
          throw new NodeConfigurationError(409, 'node-connection-primary-mismatch')
        }
        const active = await query.query(`SELECT 1 FROM harness.node_agents
          WHERE organization_id=$1 AND node_id=$2 AND attachment_state='managed' AND lease_expires_at>clock_timestamp()`,
        [this.context.organizationId, this.context.nodeId])
        if (active.rowCount !== 0) throw new NodeConfigurationError(409, 'node-connection-already-connected')
        const record: Record = { version: 1, revision: (current?.revision ?? 0) + 1,
          organizationId: this.context.organizationId as Record['organizationId'], nodeId: this.context.nodeId as Record['nodeId'],
          centerUrl: candidate.centerUrl, localGatewayUrl: `http://127.0.0.1:${this.cfg.port}`,
          stateFile: join(dirname(this.file), 'node-credentials', `${randomUUID()}.json`), enrollmentToken: parsed.data.enrollmentToken }
        await write(this.file, record, signal)
        return this.status(record, query)
      }, { waitMs: 0 })
    })
  }

  /** Start the installed independent service; installation remains operator-owned. @param actor - current administrator. */
  start(actor: UserRow): Promise<NodeConnectionView> {
    return this.authority.run(actor.id, async (signal, _epoch, query) => {
      let record = await read(this.file)
      if (record === undefined) throw new NodeConfigurationError(409, 'node-connection-not-configured')
      const policy = await this.topology.read(query)
      if (policy.mode !== 'multi' || policy.primary?.origin !== record.centerUrl || policy.primary.nodeId === this.context.nodeId) {
        throw new NodeConfigurationError(409, 'node-connection-primary-mismatch')
      }
      if (!this.cfg.publicOrigins.includes(record.centerUrl)) throw new NodeConfigurationError(409, 'node-connection-origin-not-configured')
      await query.query('SELECT 1 FROM harness.node_agents WHERE organization_id=$1 AND node_id=$2 FOR UPDATE', [this.context.organizationId, this.context.nodeId])
      const status = (await this.status(record, query)).connectionState
      if (status === 'connected') throw new NodeConfigurationError(409, 'node-connection-already-connected')
      if (status === 'independent' || status === 'revoked') throw new NodeConfigurationError(409, 'node-connection-new-enrollment-required')
      const localGatewayUrl = `http://127.0.0.1:${this.cfg.port}`
      if (record.localGatewayUrl !== localGatewayUrl) {
        const previous = record
        record = await withFileLock(this.file, async () => {
          const current = await read(this.file)
          if (current?.revision !== previous.revision) throw new NodeConfigurationError(409, 'node-connection-revision-conflict')
          const next = { ...current, revision: current.revision + 1, localGatewayUrl }
          await write(this.file, next, signal)
          return next
        }, { waitMs: 0 })
      }
      const command = process.platform === 'darwin' ? ['launchctl', 'kickstart', '-k', this.service]
        : process.platform === 'linux' ? ['systemctl', '--no-ask-password', '--no-pager', 'restart', this.service] : undefined
      if (command === undefined) throw new NodeConfigurationError(409, 'node-connection-platform-unsupported')
      try { await runGatewayChildCommand(command[0]!, command.slice(1), this.cfg.systemdCommandTimeoutMs, signal, 8192) }
      catch (error) { throw new NodeConfigurationError(409, 'node-connection-service-start-failed', { cause: error }) }
      return this.status(record, query)
    })
  }
}
