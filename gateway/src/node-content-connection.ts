/** Connect only when a project or its administrator addresses this computer's content volume. */
import type { Pool } from 'pg'
import type { GatewayConfig } from './config.ts'
import { readNodeContentDatabaseUrl } from './node-content-credentials.ts'
import { createPostgresPool } from './postgres/database.ts'
import { NodeContentStore, NodeContentUnavailable } from './node-content-store.ts'

import type { NodeContentHealth } from './node-content-health.ts'

/** Share a verification flight and keep failures on the affected volume. */
export class NodeContentConnection implements Pick<NodeContentStore, 'read' | 'write'> {
  private pool?: Pool
  private opening?: Promise<NodeContentStore>
  private closed = false

  constructor(private readonly cfg: GatewayConfig, private readonly identity: { organizationId: string; nodeId: string }) {}

  /** @returns the attested store or a refusal confined to this computer's space. */
  ready(): Promise<NodeContentStore> {
    if (this.closed || this.cfg.nodeContent === undefined) return Promise.reject(new NodeContentUnavailable())
    if (this.opening !== undefined) return this.opening
    const config = this.cfg.nodeContent
    this.opening = (async () => {
      const url = await readNodeContentDatabaseUrl(config.databaseUrlFile)
      if (this.closed) throw new NodeContentUnavailable()
      const pool = createPostgresPool(url, { traceRole:'content', max: this.cfg.databaseMaxConnections, maxCheckoutQueue: this.cfg.databaseMaxCheckoutQueue,
        connectionTimeoutMillis: this.cfg.databaseConnectionTimeoutMs })
      this.pool = pool
      try {
        return await NodeContentStore.open({ ...this.identity, pool, volumeId: config.volumeId, dataDirectory: config.dataDirectory,
          proofTimeoutMs: this.cfg.runtimeRequestTimeoutMs })
      } catch (error) {
        await pool.end()
        this.pool = undefined
        throw error
      }
    })().catch(() => {
      this.opening = undefined
      throw new NodeContentUnavailable()
    })
    return this.opening
  }

  read: NodeContentStore['read'] = async (binding, work, signal, generation) =>
    (await this.ready()).read(binding, work, signal, generation)

  write: NodeContentStore['write'] = async (binding, work, generation) =>
    (await this.ready()).write(binding, work, generation)

  confirmCollaborationRead: NodeContentStore['confirmCollaborationRead'] = async (binding,revision,finish,generation) =>
    (await this.ready()).confirmCollaborationRead(binding,revision,finish,generation)

  readVolume: NodeContentStore['readVolume'] = async (work, signal) => (await this.ready()).readVolume(work, signal)

  writeVolume: NodeContentStore['writeVolume'] = async (work, signal) => (await this.ready()).writeVolume(work, signal)

  /** @returns the result of a fresh physical volume check, without starting a Runtime. */
  async health(): Promise<NodeContentHealth> {
    const config = this.cfg.nodeContent
    const identity = { protocol: 1 as const, nodeId: this.identity.nodeId }
    if (config === undefined) return { ...identity, status: 'unconfigured' }
    const location = { ...identity, volumeId: config.volumeId, dataDirectory: config.dataDirectory }
    try {
      const alreadyOpen = this.opening !== undefined
      await this.ready()
      if (!alreadyOpen) return { ...location, status: 'verified' }
      if (this.pool === undefined || this.closed) return { ...location, status: 'unavailable' }
      await NodeContentStore.open({ ...this.identity, pool: this.pool, volumeId: config.volumeId, dataDirectory: config.dataDirectory,
        proofTimeoutMs: this.cfg.runtimeRequestTimeoutMs })
      return { ...location, status: 'verified' }
    } catch { return { ...location, status: 'unavailable' } }
  }

  /** Drain verifications and release node connections after request shutdown. */
  async close(): Promise<void> {
    this.closed = true
    await this.opening?.catch(() => undefined)
    await this.pool?.end()
  }
}
