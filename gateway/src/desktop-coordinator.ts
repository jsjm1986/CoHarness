import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { GatewayPrincipalClaims, PrincipalScope } from './principal.ts'
import type { RuntimeTarget } from './instances.ts'

/**
 * Gateway-side coordination for interactive-desktop drivers. One durable grant
 * per `{node, desktop}` resource serializes computer-use/browser-use drivers
 * across runtimes; the design note `.agents/notes/implemented/architecture/
 * 2026-09-19-desktop-resource-coordination.md` owns the rationale.
 */

export interface DesktopResourceRef {
  /** Execution node hosting the interactive desktop session. */
  node: string
  /** Node-reported interactive desktop identifier. */
  desktop: string
}

export function desktopResourceKey(resource: DesktopResourceRef): string {
  return `${resource.node}/${resource.desktop}`
}

export type DesktopGrantState = 'held' | 'stopping' | 'pending-confirm' | 'released'
export type DesktopQueueState = 'queued' | 'cancelled' | 'expired' | 'promoted'
export type DesktopResourceState = 'available' | 'unavailable'

/** Server-verified identity; background executions do not mint browser assertions. */
export type DesktopIdentity = Pick<GatewayPrincipalClaims, 'organization' | 'runtime' | 'scope'> & {
  user: Pick<GatewayPrincipalClaims['user'], 'id' | 'username'>
}

/** Holder identity projected from verified execution or interactive identity. */
export interface DesktopHolder {
  organization: string
  runtime: { kind: 'user' | 'project'; id: number; generation: number }
  user: { id: number; username: string }
  scope: PrincipalScope
  /** Exact driving Session or workflow; all grant operations must preserve it. */
  runId?: string
}

export function desktopHolderOf(claims: DesktopIdentity, runId?: string): DesktopHolder {
  return {
    organization: claims.organization,
    runtime: { kind: claims.runtime.kind, id: claims.runtime.id, generation: claims.runtime.generation },
    user: { id: claims.user.id, username: claims.user.username },
    scope: claims.scope,
    ...(runId === undefined ? {} : { runId }),
  }
}

/** Bind resource ownership to verified identity and the exact driving workflow. */
export function desktopHolderKey(holder: DesktopHolder): string {
  const identity = holder.runId === undefined ? holder : {
    organization: holder.organization, runtime: holder.runtime, runId: holder.runId,
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export interface DesktopResourceRow {
  resourceKey: string
  node: string
  desktop: string
  fencingSeq: number
  queueSeq: number
  state: DesktopResourceState
  stateNote: string | null
  updatedAt: number
}

export interface DesktopGrantRow {
  grantId: string
  resourceKey: string
  fencing: number
  holderKey: string
  holderJson: string
  requestId: string
  state: DesktopGrantState
  reason: string | null
  acquiredAt: number
  heartbeatAt: number
  stoppingAt: number | null
  releasedAt: number | null
}

export interface DesktopQueueRow {
  queueId: string
  resourceKey: string
  position: number
  holderKey: string
  holderJson: string
  requestId: string
  state: DesktopQueueState
  queuedAt: number
  settledAt: number | null
  grantId: string | null
}

export type DesktopGrantPatch = Partial<Pick<DesktopGrantRow, 'state' | 'reason' | 'heartbeatAt' | 'stoppingAt' | 'releasedAt'>>
export type DesktopQueuePatch = Partial<Pick<DesktopQueueRow, 'state' | 'settledAt' | 'grantId'>>

/** Transactional view over one coordination operation. */
export interface DesktopCoordinatorTx {
  resource(resourceKey: string): Promise<DesktopResourceRow | undefined>
  upsertResource(row: DesktopResourceRow): Promise<void>
  grantById(grantId: string): Promise<DesktopGrantRow | undefined>
  activeGrant(resourceKey: string): Promise<DesktopGrantRow | undefined>
  grantByRequest(resourceKey: string, holderKey: string, requestId: string): Promise<DesktopGrantRow | undefined>
  insertGrant(row: DesktopGrantRow): Promise<void>
  updateGrant(grantId: string, patch: DesktopGrantPatch): Promise<void>
  liveQueue(resourceKey: string): Promise<DesktopQueueRow[]>
  queueEntryByRequest(resourceKey: string, holderKey: string, requestId: string): Promise<DesktopQueueRow | undefined>
  queueSize(resourceKey: string): Promise<number>
  insertQueueEntry(row: DesktopQueueRow): Promise<void>
  updateQueueEntry(queueId: string, patch: DesktopQueuePatch): Promise<void>
  nextFencing(resourceKey: string): Promise<number>
  nextPosition(resourceKey: string): Promise<number>
  staleGrants(heartbeatCutoff: number): Promise<DesktopGrantRow[]>
  staleStopping(confirmCutoff: number): Promise<DesktopGrantRow[]>
  staleQueue(queueCutoff: number): Promise<DesktopQueueRow[]>
}

export interface DesktopCoordinatorRepository {
  initialize(): Promise<void>
  /** Run `fn` holding an exclusive lock on one resource's coordination state. */
  transact<T>(resourceKey: string, fn: (tx: DesktopCoordinatorTx) => Promise<T>): Promise<T>
  /** Run `fn` holding the coordinator-wide lock (cross-resource sweeps). */
  transactAll<T>(fn: (tx: DesktopCoordinatorTx) => Promise<T>): Promise<T>
  /** Consistent snapshot for admin/listing reads; no lock held. */
  snapshot(resourceKey: string): Promise<{ resource: DesktopResourceRow | undefined; grants: DesktopGrantRow[]; queue: DesktopQueueRow[] }>
  listResources(): Promise<DesktopResourceRow[]>
}

export class DesktopCoordinationError extends Error {
  constructor(
    readonly code:
      | 'stale-generation'
      | 'unavailable'
      | 'queue-full'
      | 'forbidden'
      | 'not-found'
      | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'DesktopCoordinationError'
  }
}

export interface DesktopCoordinatorConfig {
  /** Heartbeat TTL for a held grant. */
  grantTtlMs: number
  /** Time the holder has to confirm drained input after a grant stops. */
  stoppingTtlMs: number
  /** Max wait for a queued request before it expires. */
  queueTtlMs: number
  /** Max live queue entries per resource. */
  queueCapacity: number
}

export const DEFAULT_DESKTOP_COORDINATOR_CONFIG: DesktopCoordinatorConfig = {
  grantTtlMs: 30_000,
  stoppingTtlMs: 60_000,
  queueTtlMs: 10 * 60 * 1000,
  queueCapacity: 32,
}

export interface DesktopGenerationSource {
  generationOf(target: RuntimeTarget): Promise<number>
}

export interface DesktopAuditSink {
  write(entry: { userId?: number; action: string; methodPath?: string; status?: number; detail?: string }): void | Promise<void>
}

export type DesktopAcquireResult =
  | { status: 'granted'; grantId: string; fencing: number; grantTtlMs: number }
  | { status: 'held'; grantId: string; fencing: number; grantTtlMs: number }
  | { status: 'queued'; queueId: string; position: number }

export type DesktopStatusResult =
  | { status: 'granted'; grantId: string; fencing: number; grantTtlMs: number }
  | { status: 'stopping'; grantId: string }
  | { status: 'released'; grantId: string }
  | { status: 'queued'; queueId: string; position: number }
  | { status: 'cancelled' | 'expired' | 'unknown' }

export class DesktopCoordinator {
  constructor(
    private readonly repository: DesktopCoordinatorRepository,
    private readonly generations: DesktopGenerationSource,
    private readonly config: DesktopCoordinatorConfig = DEFAULT_DESKTOP_COORDINATOR_CONFIG,
    private readonly audit?: DesktopAuditSink,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async initialize(): Promise<void> {
    await this.repository.initialize()
    await this.sweep()
  }

  private runtimeTargetOf(holder: DesktopHolder): RuntimeTarget {
    return { kind: holder.runtime.kind, id: holder.runtime.id }
  }

  private async assertCurrentGeneration(claims: DesktopIdentity): Promise<void> {
    const current = await this.generations.generationOf({ kind: claims.runtime.kind, id: claims.runtime.id })
    if (current !== claims.runtime.generation) {
      throw new DesktopCoordinationError(
        'stale-generation',
        `runtime ${claims.runtime.kind}:${String(claims.runtime.id)} generation ${String(claims.runtime.generation)} is stale (current ${String(current)})`,
      )
    }
  }

  async acquire(claims: DesktopIdentity, input: DesktopResourceRef & { requestId: string; runId?: string }): Promise<DesktopAcquireResult> {
    await this.assertCurrentGeneration(claims)
    const holder = desktopHolderOf(claims, input.runId)
    const holderKey = desktopHolderKey(holder)
    const resourceKey = desktopResourceKey(input)
    const now = this.now()
    const result = await this.repository.transact(resourceKey, async (tx) => {
      let resource = await tx.resource(resourceKey)
      if (resource === undefined) {
        resource = {
          resourceKey,
          node: input.node,
          desktop: input.desktop,
          fencingSeq: 0,
          queueSeq: 0,
          state: 'available',
          stateNote: null,
          updatedAt: now,
        }
        await tx.upsertResource(resource)
      }
      const existingGrant = await tx.grantByRequest(resourceKey, holderKey, input.requestId)
      if (existingGrant !== undefined && existingGrant.state !== 'released') {
        if (existingGrant.state === 'held') {
          return { status: 'held', grantId: existingGrant.grantId, fencing: existingGrant.fencing, grantTtlMs: this.config.grantTtlMs } satisfies DesktopAcquireResult
        }
        throw new DesktopCoordinationError('conflict', `grant ${existingGrant.grantId} for this request is ${existingGrant.state}`)
      }
      const existingQueue = await tx.queueEntryByRequest(resourceKey, holderKey, input.requestId)
      if (existingQueue !== undefined && existingQueue.state === 'queued') {
        return { status: 'queued', queueId: existingQueue.queueId, position: existingQueue.position } satisfies DesktopAcquireResult
      }
      if (resource.state === 'unavailable') {
        throw new DesktopCoordinationError('unavailable', `desktop ${resourceKey} is unavailable${resource.stateNote === null ? '' : `: ${resource.stateNote}`}`)
      }
      const active = await tx.activeGrant(resourceKey)
      if (active === undefined) {
        const fencing = await tx.nextFencing(resourceKey)
        const grant: DesktopGrantRow = {
          grantId: randomUUID(),
          resourceKey,
          fencing,
          holderKey,
          holderJson: JSON.stringify(holder),
          requestId: input.requestId,
          state: 'held',
          reason: null,
          acquiredAt: now,
          heartbeatAt: now,
          stoppingAt: null,
          releasedAt: null,
        }
        await tx.insertGrant(grant)
        return { status: 'granted', grantId: grant.grantId, fencing, grantTtlMs: this.config.grantTtlMs } satisfies DesktopAcquireResult
      }
      const activeHolder = JSON.parse(active.holderJson) as DesktopHolder
      if (active.holderKey === holderKey && activeHolder.runId === holder.runId) {
        return { status: 'held', grantId: active.grantId, fencing: active.fencing, grantTtlMs: this.config.grantTtlMs } satisfies DesktopAcquireResult
      }
      const size = await tx.queueSize(resourceKey)
      if (size >= this.config.queueCapacity) {
        throw new DesktopCoordinationError('queue-full', `desktop ${resourceKey} queue is full`)
      }
      const position = await tx.nextPosition(resourceKey)
      const entry: DesktopQueueRow = {
        queueId: randomUUID(),
        resourceKey,
        position,
        holderKey,
        holderJson: JSON.stringify(holder),
        requestId: input.requestId,
        state: 'queued',
        queuedAt: now,
        settledAt: null,
        grantId: null,
      }
      await tx.insertQueueEntry(entry)
      return { status: 'queued', queueId: entry.queueId, position } satisfies DesktopAcquireResult
    })
    if (result.status === 'granted') {
      await this.audit?.write({ userId: claims.user.id, action: 'desktop.grant', detail: JSON.stringify({ resourceKey, grantId: result.grantId, fencing: result.fencing }) })
    }
    return result
  }

  async status(claims: DesktopIdentity, input: DesktopResourceRef & { requestId: string; runId?: string }): Promise<DesktopStatusResult> {
    const holderKey = desktopHolderKey(desktopHolderOf(claims, input.runId))
    const resourceKey = desktopResourceKey(input)
    return this.repository.transact(resourceKey, async (tx) => {
      const grant = await tx.grantByRequest(resourceKey, holderKey, input.requestId)
      if (grant !== undefined) {
        if (grant.state === 'held') return { status: 'granted', grantId: grant.grantId, fencing: grant.fencing, grantTtlMs: this.config.grantTtlMs }
        if (grant.state === 'released') return { status: 'released', grantId: grant.grantId }
        return { status: 'stopping', grantId: grant.grantId }
      }
      const entry = await tx.queueEntryByRequest(resourceKey, holderKey, input.requestId)
      if (entry === undefined) return { status: 'unknown' }
      if (entry.state === 'queued') return { status: 'queued', queueId: entry.queueId, position: entry.position }
      if (entry.state === 'promoted' && entry.grantId !== null) {
        const grant = await tx.grantById(entry.grantId)
        if (grant?.state === 'held') return { status: 'granted', grantId: grant.grantId, fencing: grant.fencing, grantTtlMs: this.config.grantTtlMs }
      }
      return { status: entry.state === 'promoted' ? 'unknown' : entry.state }
    })
  }

  async heartbeat(claims: DesktopIdentity, grantId: string, runId?: string, resource?: DesktopResourceRef): Promise<'held' | 'stopping' | 'lost'> {
    await this.assertCurrentGeneration(claims)
    const holderKey = desktopHolderKey(desktopHolderOf(claims, runId))
    const grant = await this.grantForCaller(grantId, holderKey)
    if (grant !== undefined && resource !== undefined && grant.resourceKey !== desktopResourceKey(resource)) {
      throw new DesktopCoordinationError('forbidden', 'desktop grant belongs to another resource')
    }
    if (grant === undefined || grant.holderKey !== holderKey) return 'lost'
    return this.repository.transact(grant.resourceKey, async (tx) => {
      const current = await tx.grantById(grantId)
      if (current === undefined || current.state === 'released' || current.holderKey !== holderKey) return 'lost'
      if (current.state !== 'held') return 'stopping'
      await tx.updateGrant(grantId, { heartbeatAt: this.now() })
      return 'held'
    })
  }

  /** Mark uncertain driver drainage without allowing a queued workflow to start. */
  async stop(claims: DesktopIdentity, grantId: string, runId?: string, resource?: DesktopResourceRef): Promise<void> {
    const holderKey = desktopHolderKey(desktopHolderOf(claims, runId))
    const grant = await this.grantForCaller(grantId, holderKey)
    if (grant === undefined || grant.holderKey !== holderKey
      || (resource !== undefined && grant.resourceKey !== desktopResourceKey(resource))) {
      throw new DesktopCoordinationError('forbidden', 'desktop grant belongs to another workflow or resource')
    }
    await this.repository.transact(grant.resourceKey, async tx => {
      const current = await tx.grantById(grantId)
      if (current === undefined || current.holderKey !== holderKey || current.state === 'released') {
        throw new DesktopCoordinationError('conflict', 'desktop grant has already settled')
      }
      if (current.state === 'held') await tx.updateGrant(grantId, {
        state: 'stopping', reason: 'driver-stop-unconfirmed', stoppingAt: this.now(),
      })
    })
  }

  async release(claims: DesktopIdentity, grantId: string, runId?: string, resource?: DesktopResourceRef): Promise<void> {
    const holderKey = desktopHolderKey(desktopHolderOf(claims, runId))
    const grant = await this.grantForCaller(grantId, holderKey)
    if (grant !== undefined && resource !== undefined && grant.resourceKey !== desktopResourceKey(resource)) {
      throw new DesktopCoordinationError('forbidden', 'desktop grant belongs to another resource')
    }
    if (grant === undefined || grant.holderKey !== holderKey) {
      throw new DesktopCoordinationError('forbidden', `grant ${grantId} is not held by this runtime`)
    }
    await this.repository.transact(grant.resourceKey, async (tx) => {
      const current = await tx.grantById(grantId)
      if (current === undefined || current.state === 'released' || current.holderKey !== holderKey) {
        throw new DesktopCoordinationError('forbidden', `grant ${grantId} is not held by this runtime`)
      }
      await this.settleGrant(tx, current, 'released', null)
      await this.promoteNext(tx, grant.resourceKey)
    })
  }

  async cancel(claims: DesktopIdentity, input: DesktopResourceRef & { requestId: string; runId?: string }): Promise<boolean> {
    const holderKey = desktopHolderKey(desktopHolderOf(claims, input.runId))
    const resourceKey = desktopResourceKey(input)
    return this.repository.transact(resourceKey, async (tx) => {
      const entry = await tx.queueEntryByRequest(resourceKey, holderKey, input.requestId)
      if (entry === undefined || entry.state !== 'queued') return false
      await tx.updateQueueEntry(entry.queueId, { state: 'cancelled', settledAt: this.now() })
      return true
    })
  }

  async confirmStopped(claims: DesktopIdentity, grantId: string, runId?: string, resource?: DesktopResourceRef): Promise<void> {
    const holderKey = desktopHolderKey(desktopHolderOf(claims, runId))
    const grant = await this.grantForCaller(grantId, holderKey)
    if (grant !== undefined && resource !== undefined && grant.resourceKey !== desktopResourceKey(resource)) {
      throw new DesktopCoordinationError('forbidden', 'desktop grant belongs to another resource')
    }
    if (grant === undefined || grant.holderKey !== holderKey) {
      throw new DesktopCoordinationError('forbidden', `grant ${grantId} is not held by this runtime`)
    }
    await this.repository.transact(grant.resourceKey, async (tx) => {
      const current = await tx.grantById(grantId)
      if (current === undefined || current.holderKey !== holderKey) {
        throw new DesktopCoordinationError('forbidden', `grant ${grantId} is not held by this runtime`)
      }
      if (current.state !== 'stopping' && current.state !== 'pending-confirm') {
        throw new DesktopCoordinationError('conflict', `grant ${grantId} is not stopping`)
      }
      await this.settleGrant(tx, current, 'released', null)
      await this.promoteNext(tx, grant.resourceKey)
    })
  }

  /** Admin revocation: a held grant moves to stopping; the driver learns via heartbeat. */
  async revoke(grantId: string, admin: { userId: number }): Promise<void> {
    const grant = await this.grantForCaller(grantId)
    if (grant === undefined) throw new DesktopCoordinationError('not-found', `no grant ${grantId}`)
    await this.repository.transact(grant.resourceKey, async (tx) => {
      const current = await tx.grantById(grantId)
      if (current === undefined) throw new DesktopCoordinationError('not-found', `no grant ${grantId}`)
      if (current.state !== 'held') throw new DesktopCoordinationError('conflict', `grant ${grantId} is ${current.state}`)
      await tx.updateGrant(grantId, { state: 'stopping', reason: 'revoked', stoppingAt: this.now() })
    })
    await this.audit?.write({ userId: admin.userId, action: 'desktop.revoke', detail: JSON.stringify({ grantId, resourceKey: grant.resourceKey }) })
  }

  /** Admin force-release of an unconfirmable desktop; unblocks the resource. */
  async clearUnavailable(resource: DesktopResourceRef, admin: { userId: number }): Promise<void> {
    const resourceKey = desktopResourceKey(resource)
    await this.repository.transact(resourceKey, async (tx) => {
      const row = await tx.resource(resourceKey)
      if (row === undefined) throw new DesktopCoordinationError('not-found', `no desktop ${resourceKey}`)
      const active = await tx.activeGrant(resourceKey)
      if (active !== undefined) {
        await this.settleGrant(tx, active, 'released', 'admin-clear')
      }
      if (row.state === 'unavailable') {
        await tx.upsertResource({ ...row, state: 'available', stateNote: null, updatedAt: this.now() })
      }
      await this.promoteNext(tx, resourceKey)
    })
    await this.audit?.write({ userId: admin.userId, action: 'desktop.clear', detail: JSON.stringify({ resourceKey }) })
  }

  /** Admin-facing resource list. */
  async listResources(): Promise<DesktopResourceRow[]> {
    return this.repository.listResources()
  }

  /** Admin-facing per-resource detail. */
  async snapshot(resource: DesktopResourceRef): Promise<{ resource: DesktopResourceRow | undefined; grants: DesktopGrantRow[]; queue: DesktopQueueRow[] }> {
    return this.repository.snapshot(desktopResourceKey(resource))
  }

  /** Timeout pass: heartbeat loss → stopping, confirm deadline → pending-confirm, queue expiry. */
  async sweep(now = this.now()): Promise<void> {
    await this.repository.transactAll(async (tx) => {
      for (const grant of await tx.staleGrants(now - this.config.grantTtlMs)) {
        await tx.updateGrant(grant.grantId, { state: 'stopping', reason: 'heartbeat-timeout', stoppingAt: now })
      }
      for (const grant of await tx.staleStopping(now - this.config.stoppingTtlMs)) {
        await this.markPendingConfirm(tx, grant, 'confirmation deadline elapsed')
      }
      for (const entry of await tx.staleQueue(now - this.config.queueTtlMs)) {
        await tx.updateQueueEntry(entry.queueId, { state: 'expired', settledAt: now })
      }
    })
  }

  private async markPendingConfirm(tx: DesktopCoordinatorTx, grant: DesktopGrantRow, note: string): Promise<void> {
    await tx.updateGrant(grant.grantId, { state: 'pending-confirm' })
    const row = await tx.resource(grant.resourceKey)
    if (row !== undefined && row.state !== 'unavailable') {
      await tx.upsertResource({ ...row, state: 'unavailable', stateNote: note, updatedAt: this.now() })
    }
  }

  private async settleGrant(tx: DesktopCoordinatorTx, grant: DesktopGrantRow, state: 'released', reason: string | null): Promise<void> {
    await tx.updateGrant(grant.grantId, { state, reason, releasedAt: this.now() })
    const row = await tx.resource(grant.resourceKey)
    if (row !== undefined && row.state === 'unavailable') {
      await tx.upsertResource({ ...row, state: 'available', stateNote: null, updatedAt: this.now() })
    }
  }

  /** Promote the FIFO head into a fresh grant; stale-generation entries expire first. */
  private async promoteNext(tx: DesktopCoordinatorTx, resourceKey: string): Promise<void> {
    const row = await tx.resource(resourceKey)
    if (row === undefined || row.state === 'unavailable') return
    if (await tx.activeGrant(resourceKey) !== undefined) return
    for (const entry of await tx.liveQueue(resourceKey)) {
      const holder = JSON.parse(entry.holderJson) as DesktopHolder
      const current = await this.generations.generationOf(this.runtimeTargetOf(holder))
      if (current !== holder.runtime.generation) {
        await tx.updateQueueEntry(entry.queueId, { state: 'expired', settledAt: this.now() })
        continue
      }
      const fencing = await tx.nextFencing(resourceKey)
      const now = this.now()
      const grant: DesktopGrantRow = {
        grantId: randomUUID(),
        resourceKey,
        fencing,
        holderKey: entry.holderKey,
        holderJson: entry.holderJson,
        requestId: entry.requestId,
        state: 'held',
        reason: null,
        acquiredAt: now,
        heartbeatAt: now,
        stoppingAt: null,
        releasedAt: null,
      }
      await tx.insertGrant(grant)
      await tx.updateQueueEntry(entry.queueId, { state: 'promoted', settledAt: now, grantId: grant.grantId })
      return
    }
  }

  private async grantForCaller(grantId: string, _holderKey?: string): Promise<DesktopGrantRow | undefined> {
    return this.repository.transactAll(async (tx) => tx.grantById(grantId))
  }
}

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS desktop_resources (
  resource_key TEXT PRIMARY KEY,
  node TEXT NOT NULL,
  desktop TEXT NOT NULL,
  fencing_seq INTEGER NOT NULL DEFAULT 0,
  queue_seq INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'available',
  state_note TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_grants (
  grant_id TEXT PRIMARY KEY,
  resource_key TEXT NOT NULL,
  fencing INTEGER NOT NULL,
  holder_key TEXT NOT NULL,
  holder_json TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  stopping_at INTEGER,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS desktop_grants_resource ON desktop_grants(resource_key, state);
CREATE INDEX IF NOT EXISTS desktop_grants_request ON desktop_grants(resource_key, holder_key, request_id);
CREATE TABLE IF NOT EXISTS desktop_queue (
  queue_id TEXT PRIMARY KEY,
  resource_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  holder_key TEXT NOT NULL,
  holder_json TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  settled_at INTEGER,
  grant_id TEXT
);
CREATE INDEX IF NOT EXISTS desktop_queue_resource ON desktop_queue(resource_key, state, position);
CREATE INDEX IF NOT EXISTS desktop_queue_request ON desktop_queue(resource_key, holder_key, request_id);
`

interface SqliteResourceRow {
  resource_key: string
  node: string
  desktop: string
  fencing_seq: number
  queue_seq: number
  state: string
  state_note: string | null
  updated_at: number
}

interface SqliteGrantRow {
  grant_id: string
  resource_key: string
  fencing: number
  holder_key: string
  holder_json: string
  request_id: string
  state: string
  reason: string | null
  acquired_at: number
  heartbeat_at: number
  stopping_at: number | null
  released_at: number | null
}

interface SqliteQueueRow {
  queue_id: string
  resource_key: string
  position: number
  holder_key: string
  holder_json: string
  request_id: string
  state: string
  queued_at: number
  settled_at: number | null
  grant_id: string | null
}

function resourceRowOf(row: SqliteResourceRow): DesktopResourceRow {
  return {
    resourceKey: row.resource_key,
    node: row.node,
    desktop: row.desktop,
    fencingSeq: row.fencing_seq,
    queueSeq: row.queue_seq,
    state: row.state as DesktopResourceState,
    stateNote: row.state_note,
    updatedAt: row.updated_at,
  }
}

function grantRowOf(row: SqliteGrantRow): DesktopGrantRow {
  return {
    grantId: row.grant_id,
    resourceKey: row.resource_key,
    fencing: row.fencing,
    holderKey: row.holder_key,
    holderJson: row.holder_json,
    requestId: row.request_id,
    state: row.state as DesktopGrantState,
    reason: row.reason,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    stoppingAt: row.stopping_at,
    releasedAt: row.released_at,
  }
}

function queueRowOf(row: SqliteQueueRow): DesktopQueueRow {
  return {
    queueId: row.queue_id,
    resourceKey: row.resource_key,
    position: row.position,
    holderKey: row.holder_key,
    holderJson: row.holder_json,
    requestId: row.request_id,
    state: row.state as DesktopQueueState,
    queuedAt: row.queued_at,
    settledAt: row.settled_at,
    grantId: row.grant_id,
  }
}

class SqliteCoordinatorTx implements DesktopCoordinatorTx {
  constructor(private readonly db: Database.Database) {}

  async resource(resourceKey: string): Promise<DesktopResourceRow | undefined> {
    const row = this.db.prepare(`SELECT * FROM desktop_resources WHERE resource_key = ?`).get(resourceKey) as SqliteResourceRow | undefined
    return row === undefined ? undefined : resourceRowOf(row)
  }

  async upsertResource(row: DesktopResourceRow): Promise<void> {
    this.db.prepare(
      `INSERT INTO desktop_resources(resource_key, node, desktop, fencing_seq, queue_seq, state, state_note, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(resource_key) DO UPDATE SET fencing_seq = excluded.fencing_seq, queue_seq = excluded.queue_seq, state = excluded.state, state_note = excluded.state_note, updated_at = excluded.updated_at`,
    ).run(row.resourceKey, row.node, row.desktop, row.fencingSeq, row.queueSeq, row.state, row.stateNote, row.updatedAt)
  }

  async grantById(grantId: string): Promise<DesktopGrantRow | undefined> {
    const row = this.db.prepare(`SELECT * FROM desktop_grants WHERE grant_id = ?`).get(grantId) as SqliteGrantRow | undefined
    return row === undefined ? undefined : grantRowOf(row)
  }

  async activeGrant(resourceKey: string): Promise<DesktopGrantRow | undefined> {
    const row = this.db.prepare(`SELECT * FROM desktop_grants WHERE resource_key = ? AND state != 'released'`).get(resourceKey) as SqliteGrantRow | undefined
    return row === undefined ? undefined : grantRowOf(row)
  }

  async grantByRequest(resourceKey: string, holderKey: string, requestId: string): Promise<DesktopGrantRow | undefined> {
    const row = this.db.prepare(
      `SELECT * FROM desktop_grants WHERE resource_key = ? AND holder_key = ? AND request_id = ? ORDER BY acquired_at DESC LIMIT 1`,
    ).get(resourceKey, holderKey, requestId) as SqliteGrantRow | undefined
    return row === undefined ? undefined : grantRowOf(row)
  }

  async insertGrant(row: DesktopGrantRow): Promise<void> {
    this.db.prepare(
      `INSERT INTO desktop_grants(grant_id, resource_key, fencing, holder_key, holder_json, request_id, state, reason, acquired_at, heartbeat_at, stopping_at, released_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.grantId, row.resourceKey, row.fencing, row.holderKey, row.holderJson, row.requestId, row.state, row.reason, row.acquiredAt, row.heartbeatAt, row.stoppingAt, row.releasedAt)
  }

  async updateGrant(grantId: string, patch: DesktopGrantPatch): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.state !== undefined) { sets.push('state = ?'); params.push(patch.state) }
    if (patch.reason !== undefined) { sets.push('reason = ?'); params.push(patch.reason) }
    if (patch.heartbeatAt !== undefined) { sets.push('heartbeat_at = ?'); params.push(patch.heartbeatAt) }
    if (patch.stoppingAt !== undefined) { sets.push('stopping_at = ?'); params.push(patch.stoppingAt) }
    if (patch.releasedAt !== undefined) { sets.push('released_at = ?'); params.push(patch.releasedAt) }
    if (sets.length === 0) return
    params.push(grantId)
    this.db.prepare(`UPDATE desktop_grants SET ${sets.join(', ')} WHERE grant_id = ?`).run(...params)
  }

  async liveQueue(resourceKey: string): Promise<DesktopQueueRow[]> {
    const rows = this.db.prepare(
      `SELECT * FROM desktop_queue WHERE resource_key = ? AND state = 'queued' ORDER BY position`,
    ).all(resourceKey) as SqliteQueueRow[]
    return rows.map(queueRowOf)
  }

  async queueEntryByRequest(resourceKey: string, holderKey: string, requestId: string): Promise<DesktopQueueRow | undefined> {
    const row = this.db.prepare(
      `SELECT * FROM desktop_queue WHERE resource_key = ? AND holder_key = ? AND request_id = ? ORDER BY queued_at DESC LIMIT 1`,
    ).get(resourceKey, holderKey, requestId) as SqliteQueueRow | undefined
    return row === undefined ? undefined : queueRowOf(row)
  }

  async queueSize(resourceKey: string): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM desktop_queue WHERE resource_key = ? AND state = 'queued'`).get(resourceKey) as { n: number }
    return row.n
  }

  async insertQueueEntry(row: DesktopQueueRow): Promise<void> {
    this.db.prepare(
      `INSERT INTO desktop_queue(queue_id, resource_key, position, holder_key, holder_json, request_id, state, queued_at, settled_at, grant_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.queueId, row.resourceKey, row.position, row.holderKey, row.holderJson, row.requestId, row.state, row.queuedAt, row.settledAt, row.grantId)
  }

  async updateQueueEntry(queueId: string, patch: DesktopQueuePatch): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.state !== undefined) { sets.push('state = ?'); params.push(patch.state) }
    if (patch.settledAt !== undefined) { sets.push('settled_at = ?'); params.push(patch.settledAt) }
    if (patch.grantId !== undefined) { sets.push('grant_id = ?'); params.push(patch.grantId) }
    if (sets.length === 0) return
    params.push(queueId)
    this.db.prepare(`UPDATE desktop_queue SET ${sets.join(', ')} WHERE queue_id = ?`).run(...params)
  }

  async nextFencing(resourceKey: string): Promise<number> {
    this.db.prepare(`UPDATE desktop_resources SET fencing_seq = fencing_seq + 1 WHERE resource_key = ?`).run(resourceKey)
    const row = this.db.prepare(`SELECT fencing_seq AS seq FROM desktop_resources WHERE resource_key = ?`).get(resourceKey) as { seq: number }
    return row.seq
  }

  async nextPosition(resourceKey: string): Promise<number> {
    this.db.prepare(`UPDATE desktop_resources SET queue_seq = queue_seq + 1 WHERE resource_key = ?`).run(resourceKey)
    const row = this.db.prepare(`SELECT queue_seq AS seq FROM desktop_resources WHERE resource_key = ?`).get(resourceKey) as { seq: number }
    return row.seq
  }

  async staleGrants(heartbeatCutoff: number): Promise<DesktopGrantRow[]> {
    const rows = this.db.prepare(`SELECT * FROM desktop_grants WHERE state = 'held' AND heartbeat_at < ?`).all(heartbeatCutoff) as SqliteGrantRow[]
    return rows.map(grantRowOf)
  }

  async staleStopping(confirmCutoff: number): Promise<DesktopGrantRow[]> {
    const rows = this.db.prepare(`SELECT * FROM desktop_grants WHERE state = 'stopping' AND stopping_at < ?`).all(confirmCutoff) as SqliteGrantRow[]
    return rows.map(grantRowOf)
  }

  async staleQueue(queueCutoff: number): Promise<DesktopQueueRow[]> {
    const rows = this.db.prepare(`SELECT * FROM desktop_queue WHERE state = 'queued' AND queued_at < ?`).all(queueCutoff) as SqliteQueueRow[]
    return rows.map(queueRowOf)
  }
}

/**
 * Test/embedded repository over better-sqlite3. A promise mutex serializes
 * transact/transactAll; better-sqlite3 statements are individually atomic.
 */
export class SqliteDesktopCoordinatorRepository implements DesktopCoordinatorRepository {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly db: Database.Database) {}

  async initialize(): Promise<void> {
    this.db.exec(SQLITE_DDL)
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  async transact<T>(_resourceKey: string, fn: (tx: DesktopCoordinatorTx) => Promise<T>): Promise<T> {
    return this.locked(() => fn(new SqliteCoordinatorTx(this.db)))
  }

  async transactAll<T>(fn: (tx: DesktopCoordinatorTx) => Promise<T>): Promise<T> {
    return this.locked(() => fn(new SqliteCoordinatorTx(this.db)))
  }

  async snapshot(resourceKey: string): Promise<{ resource: DesktopResourceRow | undefined; grants: DesktopGrantRow[]; queue: DesktopQueueRow[] }> {
    const tx = new SqliteCoordinatorTx(this.db)
    const resource = await tx.resource(resourceKey)
    const grants = (this.db.prepare(`SELECT * FROM desktop_grants WHERE resource_key = ? ORDER BY acquired_at`).all(resourceKey) as SqliteGrantRow[]).map(grantRowOf)
    const queue = (this.db.prepare(`SELECT * FROM desktop_queue WHERE resource_key = ? ORDER BY position`).all(resourceKey) as SqliteQueueRow[]).map(queueRowOf)
    return { resource, grants, queue }
  }

  async listResources(): Promise<DesktopResourceRow[]> {
    const rows = this.db.prepare(`SELECT * FROM desktop_resources ORDER BY resource_key`).all() as SqliteResourceRow[]
    return rows.map(resourceRowOf)
  }
}
