/** PostgreSQL records of authenticated execution inputs and current actor eligibility. @module */

import {requireNodeContentRelations,type NodeContentCheckInput} from './node-content-publication.ts'
import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { GatewayAccessMonitor } from './access-invalidation.ts'
import { transaction, type Queryable } from './postgres/database.ts'
import type { ConversationHeader } from './postgres/conversation-repository.ts'
import { publicNumber } from './postgres/runtime-context.ts'
import type { GatewayPrincipalClaims } from './principal.ts'
import type { DesktopHolder } from './desktop-coordinator.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { getProjectContentBinding, NodeContentUnavailable, type NodeContentStore } from './node-content-store.ts'

/** A refused execution identity request, without database or credential details. */
export class ExecutionIdentityError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message)
    this.name = 'ExecutionIdentityError'
  }
}

/** Canonical server-owned execution actors; input ids are non-secret witnesses, not grants. */
export interface ExecutionIdentityState {
  /** Monotonic authority-row version; equal revisions identify equal returned state. */
  revision: string
  /** Immutable participant set for one admitted execution chain. */
  scopeId?: string
  /** One immutable origin witness per actor, deduplicated across shared witnesses. */
  inputs: string[]
  actors: Array<{ userId: number }>
  /** Attribution for one invocation; never limits the actors checked for eligibility. */
  primaryActorUserId?: number
  /** Irreversible uncertainty that denies privileged capabilities. */
  unverifiedHistory: boolean
}

interface SessionRow {
  revision: string
  parent_session_id: string | null
  is_seeded: boolean
  actor_witnesses: Record<string, string>
  primary_actor_user_id: string | null
  unverified_history: boolean
  inheritance_hash: string | null
}

interface ExecutionScopeRow {
  id: string
  revision: string
  input_ids: string[]
  primary_actor_user_id: string | null
  unverified: boolean
}

interface InputRow {
  id: string
  organization_id: string
  runtime_kind: 'user' | 'project'
  runtime_public_id: string
  session_id: string
  message_id: string
  kind: 'message' | 'question'
  content_hash: string
  created_by_user_id: string
  actor_user_ids: string[]
  entered_at: Date | null
}

interface ActorRow { id: string; public_id: string; role: 'admin' | 'member'; auto_review_eligible?: boolean }
type Capability = 'execute' | 'plugin-management' | 'auto-review' | 'desktop' | 'user-terminal' | 'ssh' | 'memory'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const HASH = /^[0-9a-f]{64}$/iu

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new ExecutionIdentityError(400, 'invalid execution request fields')
  return value as Record<string, unknown>
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > 256) throw new ExecutionIdentityError(400, 'invalid execution identity')
  return value
}

function desktopRequest(value: unknown): { sessionId: string; desktop: string; owners: string[]; scopeId?: string } {
  const request = object(value, ['sessionId', 'desktop', 'ownerSessionIds', 'scopeId'])
  const sessionId = identity(request.sessionId), desktop = identity(request.desktop)
  if (request.ownerSessionIds !== undefined && !Array.isArray(request.ownerSessionIds)) throw new ExecutionIdentityError(400, 'invalid desktop runtime owners')
  const owners = request.ownerSessionIds === undefined ? [] : (request.ownerSessionIds as unknown[]).map(identity)
  if (new Set([sessionId, ...owners]).size !== owners.length + 1) throw new ExecutionIdentityError(400, 'desktop runtime ownership contains a cycle')
  return { sessionId, desktop, owners, ...(request.scopeId === undefined ? {} : { scopeId: inputId(request.scopeId) }) }
}

function inputId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ExecutionIdentityError(400, 'invalid execution input id')
  return value.toLowerCase()
}

function contentHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new ExecutionIdentityError(400, 'invalid execution content hash')
  return value.toLowerCase()
}

function primaryActor(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ExecutionIdentityError(400, 'invalid captured execution primary actor')
  }
  return value
}

function transferHash(sender: string, inputs: string[], primary: number | undefined, unverified: boolean): string {
  return createHash('sha256').update(JSON.stringify({ sender, inputs: inputs.toSorted(), primary: primary ?? null, unverified })).digest('hex')
}

type ExecutionStorage = { schema: 'harness' | 'node_content'; db: Queryable }
type ExecutionRuntimeSubject = RuntimeCredentialSubject & {
  target: RuntimeCredentialSubject['target'] & { runtimeId: RuntimeId }
  storage: ExecutionStorage
}

function scope(subject: ExecutionRuntimeSubject, sessionId: string): [string, string, number, string, RuntimeId] {
  return [subject.organizationId, subject.target.kind, subject.target.id, sessionId, subject.target.runtimeId]
}

const SESSION_COORDINATES = 'organization_id=$1 AND runtime_kind=$2 AND runtime_public_id=$3 AND session_id=$4'
const SESSION_SCOPE = `${SESSION_COORDINATES} AND runtime_id=$5`

/**
 * Validate delayed usage attribution against immutable inputs, not present-day eligibility.
 * @param database - the caller's existing accounting transaction or database connection
 * @param input - reporting Runtime, its Session, captured witness subset and primary actor; legacy owner-only reporting omits RuntimeId.
 * @returns completion when every witness and the primary actor belong to the recorded execution
 */
export async function verifyExecutionAttribution(database: Queryable, input: {
  organizationId: string
  runtime: { kind: 'user' | 'project'; id: number; runtimeId?: RuntimeId }
  sessionId: string
  inputIds: readonly string[]
  primaryActorUserId: number
}, nodeContent?: Pick<NodeContentStore,'read'>): Promise<void> {
  const binding = input.runtime.kind === 'project' && input.runtime.runtimeId !== undefined
    ? await getProjectContentBinding(database,input.organizationId,input.runtime.runtimeId) : undefined
  if (binding === undefined) return verifyAttributionStorage(database,{ schema:'harness',db:database },input)
  if (nodeContent === undefined) throw new NodeContentUnavailable()
  return nodeContent.read(binding,tx=>verifyAttributionStorage(database,{schema:'node_content',db:tx},input))
}

async function verifyAttributionStorage(database: Queryable, storage: ExecutionStorage, input: Parameters<typeof verifyExecutionAttribution>[1]): Promise<void> {
  const sessionId = identity(input.sessionId)
  if (!Array.isArray(input.inputIds) || input.inputIds.length === 0
    || !Number.isSafeInteger(input.primaryActorUserId) || input.primaryActorUserId <= 0
    || (input.runtime.kind === 'user' && input.primaryActorUserId !== input.runtime.id)) {
    throw new ExecutionIdentityError(403, 'execution attribution requires witnesses and a primary actor')
  }
  const ids = [...new Set(input.inputIds.map(inputId))]
  const inputs = await storage.db.query<{ actor_user_ids: string[]; runtime_id: RuntimeId | null }>(`SELECT actor_user_ids,runtime_id
    FROM ${storage.schema}.execution_inputs WHERE organization_id=$1 AND runtime_kind=$2 AND runtime_public_id=$3 AND id=ANY($4::uuid[])`,
  [input.organizationId, input.runtime.kind, input.runtime.id, ids])
  const runtimes = new Set(inputs.rows.map(row => row.runtime_id))
  if (inputs.rows.length !== ids.length || runtimes.size !== 1) throw new ExecutionIdentityError(403, 'execution attribution belongs to another runtime')
  const runtimeId = input.runtime.runtimeId ?? inputs.rows[0]!.runtime_id
  if (!runtimes.has(runtimeId)) throw new ExecutionIdentityError(403, 'execution attribution belongs to another runtime')
  const coordinates = [input.organizationId, input.runtime.kind, input.runtime.id, sessionId, runtimeId]
  const state = await storage.db.query<{ actor_witnesses: Record<string, string> }>(
    `SELECT actor_witnesses FROM ${storage.schema}.execution_sessions WHERE ${SESSION_COORDINATES}
      AND runtime_id IS NOT DISTINCT FROM $5::uuid`, coordinates,
  )
  if (state.rows.length !== 1) throw new ExecutionIdentityError(403, 'execution attribution belongs to another runtime')
  const scopes = await storage.db.query<{ witness: string }>(
    `SELECT DISTINCT witness FROM (SELECT unnest(input_ids) witness FROM ${storage.schema}.execution_scopes
      WHERE ${SESSION_COORDINATES} AND runtime_id IS NOT DISTINCT FROM $5::uuid
        AND input_ids && $6::uuid[]) scoped WHERE witness=ANY($6::uuid[])`,
    [...coordinates, ids],
  )
  const recorded = new Set([...Object.values(state.rows[0]!.actor_witnesses), ...scopes.rows.map(row => row.witness)])
  if (ids.some(id => !recorded.has(id))) throw new ExecutionIdentityError(403, 'execution attribution contains an unentered input')
  const actors = [...new Set(inputs.rows.flatMap(row => row.actor_user_ids))]
  const primary = await database.query(`SELECT 1 FROM harness.users
    WHERE organization_id=$1 AND public_id=$2 AND id=ANY($3::uuid[])`,
  [input.organizationId, input.primaryActorUserId, actors])
  if (primary.rowCount !== 1) throw new ExecutionIdentityError(403, 'execution attribution has an unrelated primary actor')
}

/**
 * Stream revocation hints without making database acknowledgment wait on a runtime.
 * @param monitor - the Gateway's already initialized organization monitor
 * @param response - the authenticated runtime's NDJSON response
 * @param heartbeatMs - validated liveness interval from Gateway configuration
 * @param nodeId - owning Gateway computer; other computers' qualification changes are excluded.
 * @param authorize - current Runtime credential and connection eligibility, rechecked before each heartbeat.
 * @param authorizationTimeoutMs - deadline for one authority read, independent of the heartbeat interval.
 */
export function watchExecutionAccess(monitor: GatewayAccessMonitor, response: ServerResponse, heartbeatMs: number,
  nodeId: string, authorize: () => Promise<boolean>, authorizationTimeoutMs: number): void {
  let heartbeat: NodeJS.Timeout | undefined
  let deadline: NodeJS.Timeout | undefined
  let checking = false
  let closed = false
  const write = (event: unknown): void => {
    if (response.destroyed || response.writableEnded) return
    // A slow consumer loses its stream and must recheck authority on reconnect.
    // Do not retain an application queue or await transport drain in the monitor.
    if (!response.write(`${JSON.stringify(event)}\n`)) response.destroy()
  }
  const unsubscribe = monitor.subscribe((subject) => {
    if (subject.nodeId !== undefined && subject.nodeId !== nodeId) return
    if (subject.userId === undefined && subject.projectId === undefined) response.destroy()
    else write({ type: 'invalidate', ...subject })
  })
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (deadline !== undefined) clearTimeout(deadline)
    unsubscribe()
  }
  response.once('close', cleanup)
  response.once('error', cleanup)
  if (response.destroyed || response.writableEnded) { cleanup(); return }
  if (!monitor.available) {
    cleanup()
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: 'execution-watch-unavailable' }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
  write({ type: 'ready' })
  if (!response.destroyed && !response.writableEnded) {
    heartbeat = setInterval(() => {
      if (checking || closed) return
      checking = true
      // A stalled authority read must close the local stream, not keep tools admitted.
      deadline = setTimeout(() => { response.destroy() }, authorizationTimeoutMs)
      deadline.unref()
      void authorize().then(allowed => {
        if (closed) return
        if (allowed && monitor.available) write({ type: 'heartbeat' })
        else response.destroy()
      }, () => { response.destroy() }).finally(() => {
        if (deadline !== undefined) clearTimeout(deadline)
        deadline = undefined
        checking = false
      })
    }, heartbeatMs)
    heartbeat.unref()
  }
}

/** Keeps immutable input facts separate from fresh, revocable eligibility decisions. */
export class GatewayExecutionIdentity {
  /**
   * @param pool - organization records and execution ownership.
   * @param nodeId - server-owned computer for use permission and capability qualification.
   */
  constructor(private readonly pool: Pool, private readonly nodeId: string,
    private readonly nodeContent?: Pick<NodeContentStore, 'read' | 'write'>) {}

  /** Check local immutable execution and authorization receipts for the Runtime handler's installed content store. */
  async verifyNodeContent(input:NodeContentCheckInput):Promise<void>{
    if(!this.nodeContent || input.binding.nodeId!==this.nodeId) throw new NodeContentUnavailable()
    await requireNodeContentRelations(input.local,['execution_sessions','execution_inputs','execution_scopes','execution_relays','desktop_session_confirmations'])
  }

  /**
   * Register immutable Session lineage without granting any execution authority.
   * A project Session's lineage comes from its persisted header or, before first
   * materialization, from an unexpired draft reservation for the same project,
   * which admits only a root unseeded Session.
   * @param subject - authenticated current runtime
   * @param value - parsed wire metadata
   * @param header - PostgreSQL metadata already checked against the project runtime, if applicable
   */
  async register(subject: RuntimeCredentialSubject, value: unknown, header?: Pick<ConversationHeader, 'id' | 'parentSessionId' | 'seedLength'>): Promise<void> {
    const request = object(value, ['sessionId', 'parentSessionId', 'isSeeded'])
    const sessionId = identity(request.sessionId)
    const parent = request.parentSessionId === undefined ? undefined : identity(request.parentSessionId)
    if (request.isSeeded !== undefined && typeof request.isSeeded !== 'boolean') throw new ExecutionIdentityError(400, 'invalid execution seed flag')
    const seeded = request.isSeeded === true
    if (parent === sessionId) throw new ExecutionIdentityError(409, 'execution Session cannot parent itself')
    if (subject.target.kind === 'project' && (header === undefined || header.id !== sessionId
      || header.parentSessionId !== parent || (header.seedLength !== undefined) !== seeded)) {
      throw new ExecutionIdentityError(403, 'execution Session metadata differs from persisted lineage')
    }
    await this.inRuntime(subject, async (client, subject) => {
      if (parent !== undefined) await this.session(client, subject, parent, false)
      await subject.storage.db.query(`INSERT INTO ${subject.storage.schema}.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,parent_session_id,is_seeded)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [...scope(subject, sessionId), parent ?? null, seeded])
      const stored = await this.session(client, subject, sessionId)
      if (stored.parent_session_id !== (parent ?? null) || stored.is_seeded !== seeded) {
        throw new ExecutionIdentityError(409, 'execution Session lineage is immutable')
      }
    })
  }

  /**
   * Read recorded origins for a live or cold Session without granting execution.
   * @param subject - authenticated runtime owning the registered Session
   * @param value - Session identity only; no caller-supplied actors
   * @returns current origin facts, including an empty set for unverified legacy data
   */
  async capture(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'scopeId'])
    const sessionId = identity(request.sessionId)
    return this.inRuntime(subject, async (client, subject) => request.scopeId === undefined
      ? this.state(client, subject, await this.session(client, subject, sessionId, false))
      : this.scopeState(client, subject, await this.readScope(client, subject, sessionId, inputId(request.scopeId))))
  }

  /**
   * Record one exact human message, preserving prior editors as actors.
   * @param subject - authenticated runtime
   * @param principal - verified, purpose-free browser identity
   * @param value - input metadata; callers cannot submit actors or roles
   * @returns the immutable receipt and its attributed actors
   */
  async input(subject: RuntimeCredentialSubject, principal: GatewayPrincipalClaims, value: unknown): Promise<{
    inputId: string; actors: Array<{ userId: number }>; primaryActorUserId: number
  }> {
    const request = object(value, ['sessionId', 'messageId', 'kind', 'contentHash', 'previousInputId', 'creationAuthorization'])
    if (request.kind !== 'message') throw new ExecutionIdentityError(400, 'question inputs require the question claim endpoint')
    const sessionId = identity(request.sessionId), messageId = identity(request.messageId), hash = contentHash(request.contentHash)
    const previous = request.previousInputId === undefined ? undefined : inputId(request.previousInputId)
    return this.inRuntime(subject, async (client, subject) => {
      await this.session(client, subject, sessionId)
      const actor = await this.principalActor(client, subject, sessionId, principal)
      const receipt = await this.insertInput(client, subject, sessionId, messageId, 'message', hash, actor, previous)
      const actors = await this.publicActors(client, subject, receipt.actor_user_ids)
      return { inputId: receipt.id, actors, primaryActorUserId: principal.user.id }
    })
  }

  /**
   * Merge a bound receipt into the Session's monotonically growing actor set.
   * @param subject - authenticated runtime
   * @param value - exact receipt, message, and content identities
   * @returns canonical witnesses and actors after the atomic merge
   */
  async enter(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'inputId', 'messageId', 'contentHash', 'creationAuthorization', 'unverifiedHistory', 'currentScopeId'])
    const sessionId = identity(request.sessionId), id = inputId(request.inputId)
    const messageId = identity(request.messageId), hash = contentHash(request.contentHash)
    if (request.unverifiedHistory !== undefined && typeof request.unverifiedHistory !== 'boolean') throw new ExecutionIdentityError(400, 'invalid unverified history flag')
    return this.inRuntime(subject, async (client, subject) => {
      const state = await this.session(client, subject, sessionId)
      const receipt = await this.receipt(client, subject, sessionId, id)
      if (receipt.message_id !== messageId || receipt.content_hash !== hash) throw new ExecutionIdentityError(403, 'execution input does not match the entered message')
      const recorded = await this.consume(client, subject, sessionId, state, receipt, request.unverifiedHistory === true)
      if (!('currentScopeId' in request)) return recorded
      const previous = request.currentScopeId === null ? undefined
        : await this.readScope(client, subject, sessionId, inputId(request.currentScopeId))
      return this.createScope(client, subject, sessionId, [...(previous?.input_ids ?? []), receipt.id],
        receipt.created_by_user_id, (previous?.unverified ?? false) || request.unverifiedHistory === true)
    })
  }

  /**
   * Inherit only recorded parent witnesses after immutable lineage has been checked.
   * @param subject - authenticated runtime
   * @param value - child, real parent, and the delegation-time witness subset
   * @returns the child's canonical actor set
   */
  async inherit(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'parentSessionId', 'inputs', 'primaryActorUserId', 'unverifiedHistory', 'scopeId', 'scoped'])
    const sessionId = identity(request.sessionId), parentId = identity(request.parentSessionId)
    if (sessionId === parentId || !Array.isArray(request.inputs)) throw new ExecutionIdentityError(400, 'invalid execution inheritance')
    if (request.scoped !== undefined && request.scoped !== true) throw new ExecutionIdentityError(400, 'invalid execution scope protocol')
    const inputs = [...new Set(request.inputs.map(inputId))]
    const captured = primaryActor(request.primaryActorUserId)
    if (inputs.length === 0 ? captured !== undefined || request.unverifiedHistory !== true : captured === undefined) {
      throw new ExecutionIdentityError(400, 'execution inheritance requires a primary actor or explicit empty unknown history')
    }
    await this.markUnverified(subject, sessionId, request.unverifiedHistory)
    const hash = transferHash(parentId, inputs, captured, request.unverifiedHistory === true)
    return this.inRuntime(subject, async (client, subject) => {
      const [parent, child] = await this.relatedSessions(client, subject, parentId, sessionId)
      if (child.parent_session_id !== parentId) throw new ExecutionIdentityError(403, 'execution inheritance requires the registered parent')
      if (request.scopeId !== undefined) {
        if (child.inheritance_hash !== null && child.inheritance_hash !== hash) throw new ExecutionIdentityError(409, 'execution inheritance conflicts with its first admission')
        const capturedScope = await this.readScope(client, subject, parentId, inputId(request.scopeId))
        await this.assertCapturedScope(client, subject, capturedScope, inputs, captured, request.unverifiedHistory)
        const receipts = await Promise.all(inputs.map(id => this.receipt(client, subject, undefined, id)))
        await subject.storage.db.query(`UPDATE ${subject.storage.schema}.execution_sessions SET inheritance_hash=$6 WHERE ${SESSION_SCOPE}`, [...scope(subject, sessionId), hash])
        await this.merge(client, subject, sessionId, child, receipts, capturedScope.primary_actor_user_id, capturedScope.unverified)
        return this.createScope(client, subject, sessionId, inputs, capturedScope.primary_actor_user_id, capturedScope.unverified)
      }
      const unverified = parent.unverified_history || request.unverifiedHistory === true
      if (child.inheritance_hash !== null) {
        if (child.inheritance_hash !== hash) throw new ExecutionIdentityError(409, 'execution inheritance conflicts with its first admission')
        if (request.scoped === true) {
          const receipts = await Promise.all(inputs.map(id => this.receipt(client, subject, undefined, id)))
          const primary = captured === undefined ? null : await this.capturedPrimary(client, subject, receipts, captured)
          return this.createScope(client, subject, sessionId, inputs, primary, unverified)
        }
        return this.replayTransfer(client, subject, sessionId, child, unverified)
      }
      const witnesses = new Set(Object.values(parent.actor_witnesses))
      if (inputs.some(id => !witnesses.has(id))) throw new ExecutionIdentityError(403, 'execution input was not entered by the parent')
      if (inputs.length === 0 && witnesses.size !== 0) throw new ExecutionIdentityError(403, 'empty inheritance cannot omit recorded parent actors')
      const receipts = await Promise.all(inputs.map(id => this.receipt(client, subject, undefined, id)))
      const primary = captured === undefined ? null : await this.capturedPrimary(client, subject, receipts, captured)
      await subject.storage.db.query(`UPDATE ${subject.storage.schema}.execution_sessions SET inheritance_hash=$6 WHERE ${SESSION_SCOPE}`, [...scope(subject, sessionId), hash])
      const recorded = await this.merge(client, subject, sessionId, child, receipts, child.primary_actor_user_id ?? primary, unverified)
      return request.scoped === true ? this.createScope(client, subject, sessionId, inputs, primary, unverified) : recorded
    })
  }

  /**
   * Merge a Host-captured adjacent-Agent relay without borrowing unrelated Session evidence.
   * @param subject - authenticated runtime shared by both Sessions
   * @param value - receiver, real adjacent sender, and the sender's captured witnesses
   * @returns receiver authority after the monotonic merge
   */
  async relay(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'senderSessionId', 'messageId', 'inputs', 'primaryActorUserId', 'unverifiedHistory', 'scopeId', 'scoped'])
    const sessionId = identity(request.sessionId), senderId = identity(request.senderSessionId), messageId = identity(request.messageId)
    if (sessionId === senderId || !Array.isArray(request.inputs)) throw new ExecutionIdentityError(400, 'invalid execution relay')
    if (request.scoped !== undefined && request.scoped !== true) throw new ExecutionIdentityError(400, 'invalid execution scope protocol')
    const inputs = [...new Set(request.inputs.map(inputId))]
    const captured = primaryActor(request.primaryActorUserId)
    if (inputs.length === 0 ? captured !== undefined || request.unverifiedHistory !== true : captured === undefined) {
      throw new ExecutionIdentityError(400, 'execution relay requires a primary actor or explicit empty unknown history')
    }
    await this.markUnverified(subject, sessionId, request.unverifiedHistory)
    const hash = transferHash(senderId, inputs, captured, request.unverifiedHistory === true)
    return this.inRuntime(subject, async (client, subject) => {
      const [sender, receiver] = await this.relatedSessions(client, subject, senderId, sessionId)
      if (sender.parent_session_id !== sessionId && receiver.parent_session_id !== senderId) {
        throw new ExecutionIdentityError(403, 'execution relay requires adjacent parent and child Sessions')
      }
      if (request.scopeId !== undefined) {
        const capturedScope = await this.readScope(client, subject, senderId, inputId(request.scopeId))
        await this.assertCapturedScope(client, subject, capturedScope, inputs, captured, request.unverifiedHistory)
        const previous = await subject.storage.db.query<{ request_hash: string }>(`SELECT request_hash FROM ${subject.storage.schema}.execution_relays
          WHERE ${SESSION_SCOPE} AND message_id=$6`, [...scope(subject, sessionId), messageId])
        if (previous.rows[0] !== undefined && previous.rows[0].request_hash !== hash) throw new ExecutionIdentityError(409, 'execution relay conflicts with its first admission')
        await subject.storage.db.query(`INSERT INTO ${subject.storage.schema}.execution_relays(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,message_id,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [...scope(subject, sessionId), messageId, hash])
        const receipts = await Promise.all(inputs.map(id => this.receipt(client, subject, undefined, id)))
        await this.merge(client, subject, sessionId, receiver, receipts, capturedScope.primary_actor_user_id, capturedScope.unverified)
        return this.createScope(client, subject, sessionId, inputs, capturedScope.primary_actor_user_id, capturedScope.unverified)
      }
      const unverified = sender.unverified_history || request.unverifiedHistory === true
      const previous = await subject.storage.db.query<{ request_hash: string }>(`SELECT request_hash FROM ${subject.storage.schema}.execution_relays
        WHERE ${SESSION_SCOPE} AND message_id=$6`, [...scope(subject, sessionId), messageId])
      if (previous.rows[0] !== undefined) {
        if (previous.rows[0].request_hash !== hash) throw new ExecutionIdentityError(409, 'execution relay conflicts with its first admission')
        if (request.scoped === true) {
          const receipts = await Promise.all(inputs.map(id => this.receipt(client, subject, undefined, id)))
          const primary = captured === undefined ? null : await this.capturedPrimary(client, subject, receipts, captured)
          return this.createScope(client, subject, sessionId, inputs, primary, unverified)
        }
        return this.replayTransfer(client, subject, sessionId, receiver, unverified)
      }
      const witnesses = new Set(Object.values(sender.actor_witnesses))
      if (inputs.some(id => !witnesses.has(id))) throw new ExecutionIdentityError(403, 'execution relay contains an unentered sender input')
      if (inputs.length === 0 && witnesses.size !== 0) throw new ExecutionIdentityError(403, 'empty relay cannot omit recorded sender actors')
      const receipts = await Promise.all(inputs.map(id => this.receipt(client, subject, undefined, id)))
      const primary = captured === undefined ? receiver.primary_actor_user_id : await this.capturedPrimary(client, subject, receipts, captured)
      await subject.storage.db.query(`INSERT INTO ${subject.storage.schema}.execution_relays(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,message_id,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [...scope(subject, sessionId), messageId, hash])
      const recorded = await this.merge(client, subject, sessionId, receiver, receipts, primary, unverified)
      return request.scoped === true ? this.createScope(client, subject, sessionId, inputs, primary, unverified) : recorded
    })
  }

  /**
   * Check immutable scope presence within the authenticated Session's exact Runtime.
   * @param subject - authenticated Runtime; legacy selectors resolve its current generation.
   * @param sessionId - Host Session identifier, which may repeat in another Runtime.
   * @returns whether this Runtime has immutable scopes for the Session.
   */
  async hasScopes(subject: RuntimeCredentialSubject, sessionId: string): Promise<boolean> {
    return this.inRuntime(subject, async (client, owner) => {
      const result = await owner.storage.db.query(`SELECT 1 FROM ${owner.storage.schema}.execution_scopes WHERE ${SESSION_SCOPE} LIMIT 1`, scope(owner, sessionId))
      return result.rowCount !== 0
    })
  }

  /**
   * Authorize from server-owned witnesses and current account/Session permissions.
   * @param subject - authenticated runtime
   * @param value - Session and requested capability, never caller-supplied actors
   * @returns the canonical set only when every actor remains eligible
   */
  async authorize(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'capability', 'unverifiedHistory', 'scopeId'])
    const sessionId = identity(request.sessionId), capability = request.capability
    if (capability !== 'execute' && capability !== 'plugin-management' && capability !== 'auto-review' && capability !== 'desktop' && capability !== 'memory') throw new ExecutionIdentityError(400, 'invalid execution capability')
    await this.markUnverified(subject, sessionId, request.unverifiedHistory)
    return this.inRuntime(subject, async (client, subject) => {
      if (request.scopeId !== undefined) {
        const captured = await this.readScope(client, subject, sessionId, inputId(request.scopeId))
        const receipts = await Promise.all(captured.input_ids.map(id => this.receipt(client, subject, undefined, id)))
        const actors = [...new Set(receipts.flatMap(receipt => receipt.actor_user_ids))]
        if (actors.length === 0 || captured.primary_actor_user_id === null || (capability !== 'execute' && captured.unverified)) {
          throw new ExecutionIdentityError(403, 'execution authority has no verified complete actor set')
        }
        await this.eligibleActors(client, subject, sessionId, actors, capability)
        return this.scopeState(client, subject, captured)
      }
      const state = await this.session(client, subject, sessionId)
      const actors = Object.keys(state.actor_witnesses)
      if (actors.length === 0 || state.primary_actor_user_id === null || (capability !== 'execute' && state.unverified_history)) {
        throw new ExecutionIdentityError(403, 'execution authority has no verified complete actor set')
      }
      await this.eligibleActors(client, subject, sessionId, actors, capability)
      return this.state(client, subject, state)
    })
  }

  /**
   * Check an explicit mode choice without introducing an actor or selecting a preset.
   * @param subject - authenticated runtime
   * @param principal - verified current selector
   * @param value - Session and privileged capability represented by the choice
   */
  async selection(subject: RuntimeCredentialSubject, principal: GatewayPrincipalClaims, value: unknown): Promise<void> {
    const request = object(value, ['sessionId', 'capability'])
    const sessionId = identity(request.sessionId), capability = request.capability
    if (capability !== 'plugin-management' && capability !== 'auto-review') throw new ExecutionIdentityError(400, 'invalid execution selection')
    await this.inRuntime(subject, async (client, subject) => {
      await this.session(client, subject, sessionId)
      const selector = await this.principalActor(client, subject, sessionId, principal)
      await this.eligibleActors(client, subject, sessionId, [selector], capability)
    })
  }

  /**
   * Record or withdraw the authenticated user's confirmation for this Session and desktop.
   * @param subject - current runtime credential.
   * @param principal - verified interactive requester; no model-provided actor is accepted.
   * @param nodeId - current Gateway node, supplied by the server.
   * @param value - exact Session, desktop, and confirmation decision.
   */
  async confirmDesktop(subject: RuntimeCredentialSubject, principal: GatewayPrincipalClaims, nodeId: string, value: unknown): Promise<void> {
    const request = object(value, ['sessionId', 'desktop', 'confirmed', 'expectedNodeId'])
    if (request.expectedNodeId !== undefined && request.expectedNodeId !== nodeId) throw new ExecutionIdentityError(409, 'desktop node changed; refresh confirmation')
    const sessionId = identity(request.sessionId), desktop = identity(request.desktop)
    if (typeof request.confirmed !== 'boolean') throw new ExecutionIdentityError(400, 'invalid desktop confirmation')
    await this.inRuntime(subject, async (client, subject) => {
      await this.session(client, subject, sessionId)
      const actor = await this.principalActor(client, subject, sessionId, principal)
      const coordinates = [...scope(subject, sessionId), nodeId, subject.generation, desktop, actor]
      if (!request.confirmed) {
        await subject.storage.db.query(`DELETE FROM ${subject.storage.schema}.desktop_session_confirmations WHERE ${SESSION_SCOPE}
          AND node_id=$6 AND generation=$7 AND desktop=$8 AND user_id=$9`, coordinates)
        await client.query('SELECT harness.invalidate_access($1,$2::jsonb)', [subject.organizationId, JSON.stringify({ userId: principal.user.id })])
        return
      }
      await this.eligibleActors(client, subject, sessionId, [actor], 'desktop')
      const policy = await client.query<{ user_revision: string; project_revision: string }>(`SELECT u.revision::text user_revision,
        COALESCE(p.revision,0)::text project_revision FROM harness.desktop_access_policies u
        LEFT JOIN harness.desktop_access_policies p ON p.organization_id=u.organization_id AND p.project_id=$3 AND p.node_id=$4
        WHERE u.organization_id=$1 AND u.user_id=$2 AND u.node_id=$4`, [subject.organizationId, actor, subject.projectInternalId ?? null, nodeId])
      await subject.storage.db.query(`INSERT INTO ${subject.storage.schema}.desktop_session_confirmations
        (organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,node_id,generation,desktop,user_id,user_policy_revision,project_policy_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,node_id,generation,desktop,user_id)
        DO UPDATE SET user_policy_revision=EXCLUDED.user_policy_revision,project_policy_revision=EXCLUDED.project_policy_revision,confirmed_at=now()`,
      [...coordinates, policy.rows[0]!.user_revision, policy.rows[0]!.project_revision])
    })
  }

  /**
   * Read only the current interactive user's confirmation for the live root.
   * @param subject - authenticated runtime.
   * @param principal - verified interactive requester.
   * @param nodeId - server-owned current node.
   * @param value - exact root Session and configured desktop.
   * @returns current-user eligibility and confirmation, without other participants' records.
   */
  async desktopConfirmation(subject: RuntimeCredentialSubject, principal: GatewayPrincipalClaims, nodeId: string, value: unknown) {
    const request = object(value, ['sessionId', 'desktop'])
    const sessionId = identity(request.sessionId), desktop = identity(request.desktop)
    return this.inRuntime(subject, async (client, subject) => {
      await this.session(client, subject, sessionId)
      const actor = await this.principalActor(client, subject, sessionId, principal)
      const occupancy = await this.desktopOccupancy(client, subject, nodeId, desktop, sessionId)
      const base = { rootSessionId: sessionId, nodeId, desktop, userId: principal.user.id, occupancy }
      try {
        await this.eligibleActors(client, subject, sessionId, [actor], 'desktop')
      } catch (error) {
        if (!(error instanceof ExecutionIdentityError) || error.status !== 403) throw error
        return { ...base, eligible: false, confirmed: false }
      }
      const confirmed = await this.confirmedDesktopActors(client, subject, sessionId, nodeId, desktop, [actor])
      return { ...base, eligible: true, confirmed: confirmed === 1 }
    })
  }

  /** Live grant and queue state of one desktop resource, without other holders' identities. */
  private async desktopOccupancy(client: PoolClient, subject: ExecutionRuntimeSubject, nodeId: string, desktop: string, sessionId: string) {
    const resourceKey = `${subject.organizationId}/${nodeId}/${desktop}`
    const result = await client.query<{ resource_state: string; grants: string; own_grants: string; queued: string }>(
      `SELECT dr.state AS resource_state,
        count(g.grant_id) FILTER (WHERE g.state <> 'released') AS grants,
        count(g.grant_id) FILTER (WHERE g.state <> 'released' AND g.holder_json->>'runId' = $2
          AND g.holder_json->'runtime' = $3::jsonb) AS own_grants,
        (SELECT count(*) FROM harness.desktop_queue q
          WHERE q.resource_key = dr.resource_key AND q.state = 'queued') AS queued
        FROM harness.desktop_resources dr
        LEFT JOIN harness.desktop_grants g ON g.resource_key = dr.resource_key
        WHERE dr.resource_key = $1
        GROUP BY dr.resource_key, dr.state`, [resourceKey, sessionId, JSON.stringify({ ...subject.target, generation: subject.generation })])
    const row = result.rows[0]
    const grants = Number(row?.grants ?? 0)
    return {
      available: row === undefined || row.resource_state === 'available',
      inUse: grants > 0,
      heldByThisSession: grants > 0 && Number(row?.own_grants ?? 0) > 0,
      queued: Number(row?.queued ?? 0),
    }
  }

  /**
   * Require current qualification and exact human confirmations for all recorded actors.
   * @param subject - authenticated runtime, including its current generation.
   * @param nodeId - current Gateway node; caller-supplied node identities are not accepted.
   * @param value - Session and desktop selected by the actual driver.
   * @returns canonical participants only when every confirmation remains current.
   */
  async authorizeDesktop(subject: RuntimeCredentialSubject, nodeId: string, value: unknown): Promise<ExecutionIdentityState> {
    const { sessionId, desktop, owners, scopeId } = desktopRequest(value)
    return this.inRuntime(subject, async (client, subject) => {
      const state = await this.session(client, subject, sessionId)
      const execution = scopeId === undefined ? undefined : await this.readScope(client, subject, sessionId, scopeId)
      const inputs = execution === undefined ? undefined : await Promise.all(execution.input_ids.map(id => this.receipt(client, subject, undefined, id)))
      const actors = inputs === undefined ? Object.keys(state.actor_witnesses) : [...new Set(inputs.flatMap(input => input.actor_user_ids))]
      if (actors.length === 0 || (execution?.primary_actor_user_id ?? state.primary_actor_user_id) === null || (execution?.unverified ?? state.unverified_history)) {
        throw new ExecutionIdentityError(403, 'desktop access requires verified execution actors')
      }
      await this.eligibleActors(client, subject, sessionId, actors, 'desktop')
      const { rootSessionId: confirmationSessionId } = await this.desktopRoot(client, subject, sessionId, state, owners)
      const confirmed = await this.confirmedDesktopActors(client, subject, confirmationSessionId, nodeId, desktop, actors)
      if (confirmed !== actors.length) throw new ExecutionIdentityError(403, 'each execution actor must confirm this Session and desktop again')
      return execution === undefined ? this.state(client, subject, state) : this.scopeState(client, subject, execution)
    })
  }

  private async confirmedDesktopActors(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string,
    nodeId: string, desktop: string, actors: string[]): Promise<number> {
    if (subject.storage.schema === 'node_content') {
      const local = await subject.storage.db.query<{ user_id: string; user_revision: string; project_revision: string }>(`SELECT user_id,
        user_policy_revision::text user_revision,project_policy_revision::text project_revision FROM node_content.desktop_session_confirmations
        WHERE ${SESSION_SCOPE} AND node_id=$6 AND generation=$7 AND desktop=$8 AND user_id=ANY($9::uuid[]) FOR SHARE`,
      [...scope(subject, sessionId), nodeId, subject.generation, desktop, actors])
      if (local.rows.length === 0) return 0
      const valid = await client.query(`SELECT u.user_id FROM jsonb_to_recordset($4::jsonb) r(user_id uuid,user_revision bigint,project_revision bigint)
        JOIN harness.desktop_access_policies u ON u.organization_id=$1 AND u.node_id=$2 AND u.user_id=r.user_id
          AND u.enabled AND u.revision=r.user_revision
        JOIN harness.desktop_access_policies p ON p.organization_id=$1 AND p.node_id=$2 AND p.project_id=$3
          AND p.enabled AND p.revision=r.project_revision FOR SHARE OF u,p`,
      [subject.organizationId,nodeId,subject.projectInternalId,JSON.stringify(local.rows)])
      return valid.rows.length
    }
    const confirmations = await client.query(`SELECT c.user_id FROM harness.desktop_session_confirmations c
        JOIN harness.desktop_access_policies u ON u.organization_id=c.organization_id AND u.user_id=c.user_id
          AND u.node_id=c.node_id AND u.enabled AND u.revision=c.user_policy_revision
        LEFT JOIN harness.desktop_access_policies p ON p.organization_id=c.organization_id AND p.project_id=$10 AND p.node_id=c.node_id
        WHERE c.organization_id=$1 AND c.runtime_kind=$2 AND c.runtime_public_id=$3 AND c.session_id=$4
          AND c.runtime_id=$5 AND c.node_id=$6 AND c.generation=$7 AND c.desktop=$8 AND c.user_id=ANY($9::uuid[])
          AND (CASE WHEN c.runtime_kind='project' THEN p.enabled AND p.revision=c.project_policy_revision ELSE c.project_policy_revision=0 END)
        FOR SHARE OF c`, [...scope(subject, sessionId), nodeId, subject.generation, desktop, actors, subject.projectInternalId ?? null])
    return confirmations.rows.length
  }

  /**
   * Resolve the registered root workflow without requiring a still-active desktop grant.
   * Cleanup remains possible after revocation, but cannot change runtime, node or root.
   * @param subject - authenticated current runtime.
   * @param value - driver Session, desktop and live owner chain.
   * @returns server-owned workflow identity and attribution for the coordinator.
   */
  async desktopHolder(subject: RuntimeCredentialSubject, value: unknown): Promise<DesktopHolder> {
    const { sessionId, owners, scopeId } = desktopRequest(value)
    return this.inRuntime(subject, async (client, subject) => {
      const state = await this.session(client, subject, sessionId)
      const { rootSessionId, root } = await this.desktopRoot(client, subject, sessionId, state, owners)
      const captured = scopeId === undefined ? undefined : await this.readScope(client, subject, sessionId, scopeId)
      const attribution = await client.query<{ public_id: string; username: string; organization: string; project_name: string | null }>(`
        SELECT u.public_id::text,u.username,o.slug organization,p.name project_name FROM harness.users u
        JOIN harness.organizations o ON o.id=u.organization_id
        LEFT JOIN harness.projects p ON p.organization_id=o.id AND p.id=$3
        WHERE u.organization_id=$1 AND u.id=$2`, [subject.organizationId, captured?.primary_actor_user_id ?? root.primary_actor_user_id, subject.projectInternalId ?? null])
      const actor = attribution.rows[0]
      if (actor === undefined) throw new ExecutionIdentityError(403, 'desktop workflow has no recorded actor')
      return {
        organization: actor.organization,
        runtime: { ...subject.target, generation: subject.generation },
        user: { id: publicNumber(actor.public_id, 'desktop actor'), username: actor.username },
        scope: subject.target.kind === 'user' ? { kind: 'personal' } : {
          kind: 'project', projectId: subject.target.id, projectName: actor.project_name!, mode: 'rw',
        },
        runId: rootSessionId,
      }
    })
  }

  private async desktopRoot(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string,
    state: SessionRow, owners: string[]): Promise<{ rootSessionId: string; root: SessionRow }> {
    let rootSessionId = sessionId, root = state
    // The trusted runtime supplies live ownership; durable lineage checks each asserted edge.
    for (const parentId of owners) {
      if (root.parent_session_id !== parentId || root.inheritance_hash === null) {
        throw new ExecutionIdentityError(403, 'desktop runtime owner lacks verified execution inheritance')
      }
      root = await this.session(client, subject, parentId, false)
      rootSessionId = parentId
    }
    return { rootSessionId, root }
  }

  private async markUnverified(subject: RuntimeCredentialSubject, sessionId: string, unverified: unknown): Promise<void> {
    if (unverified !== undefined && typeof unverified !== 'boolean') throw new ExecutionIdentityError(400, 'invalid unverified history flag')
    if (unverified !== true) return
    // The reported uncertainty survives a subsequent authorization refusal.
    // Keep this commit outside the transaction whose result may be a denial.
    await this.inRuntime(subject, async (client, subject) => {
      await subject.storage.db.query(`UPDATE ${subject.storage.schema}.execution_sessions SET unverified_history=true,revision=revision+1,updated_at=now()
        WHERE ${SESSION_SCOPE} AND NOT unverified_history`, scope(subject, sessionId))
    })
  }

  /**
   * Claim one authenticated human answer and merge its input in the same transaction.
   * @param subject - authenticated runtime
   * @param principal - verified current answerer
   * @param value - the Host-validated pending question and normalized JSON answer
   * @returns an idempotent claim and the canonical execution set
   */
  async question(subject: RuntimeCredentialSubject, principal: GatewayPrincipalClaims, value: unknown): Promise<ExecutionIdentityState & { claimed: true }> {
    const request = object(value, ['sessionId', 'questionId', 'answer', 'scopeId', 'callId'])
    const sessionId = identity(request.sessionId), questionId = identity(request.questionId)
    const answer = JSON.stringify(request.answer)
    const callId = request.callId === undefined ? null : identity(request.callId)
    if (answer === undefined) throw new ExecutionIdentityError(400, 'invalid execution question answer')
    const hash = createHash('sha256').update(request.scopeId === undefined ? answer
      : JSON.stringify({ answer: request.answer, scopeId: inputId(request.scopeId) })).digest('hex')
    return this.inRuntime(subject, async (client, subject) => {
      const state = await this.session(client, subject, sessionId)
      const actor = await this.principalActor(client, subject, sessionId, principal)
      if (subject.target.kind === 'project') {
        const root = await subject.storage.db.query<{ root_session_id: string }>(`SELECT root_session_id FROM ${subject.storage.schema}.conversation_sessions WHERE organization_id=$1 AND id=$2 AND runtime_id=$3`, [subject.organizationId, sessionId, subject.target.runtimeId],
        )
        const rootId = root.rows[0]?.root_session_id
        if (rootId === undefined) throw new ExecutionIdentityError(404, 'execution question Session is unavailable')
        await subject.storage.db.query(`INSERT INTO ${subject.storage.schema}.conversation_interaction_responses(
          organization_id,runtime_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome,call_id${subject.storage.schema === 'node_content' ? ',has_answers' : ''})
          VALUES($1,$7,'question',$2,$3,$4,${subject.storage.schema === 'harness' ? '$5::jsonb' : '$5::json'},$6${subject.storage.schema === 'node_content' ? ',$8' : ''}) ON CONFLICT DO NOTHING`,
        [subject.organizationId, questionId, rootId, actor, answer, callId, subject.target.runtimeId,
          ...subject.storage.schema === 'node_content' ? [typeof request.answer === 'object' && request.answer !== null
            && 'answers' in request.answer && Array.isArray(request.answer.answers)] : []])
        const claim = await subject.storage.db.query(`SELECT 1 FROM ${subject.storage.schema}.conversation_interaction_responses
          WHERE organization_id=$1 AND interaction_kind='question' AND interaction_id=$2
            AND runtime_id=$6 AND conversation_id=$3 AND responder_user_id=$4 AND ${subject.storage.schema === 'harness' ? 'outcome=$5::jsonb' : 'outcome::text=$5::text'}`,
        [subject.organizationId, questionId, rootId, actor, answer, subject.target.runtimeId])
        if (claim.rowCount !== 1) throw new ExecutionIdentityError(409, 'execution question was claimed by another response')
      }
      const receipt = await this.insertInput(client, subject, sessionId, questionId, 'question', hash, actor)
      const recorded = await this.consume(client, subject, sessionId, state, receipt, false)
      if (request.scopeId === undefined) return { claimed: true, ...recorded }
      const original = await this.readScope(client, subject, sessionId, inputId(request.scopeId))
      return { claimed: true, ...await this.createScope(client, subject, sessionId, [...original.input_ids, receipt.id],
        receipt.created_by_user_id, original.unverified) }
    })
  }

  /**
   * Combine exact admitted scopes without replacing their immutable participants.
   * @param subject - authenticated runtime owning the receiving Session.
   * @param value - own scope references and explicit unknown input state.
   * @returns a new scope; an empty unknown scope grants no execution.
   */
  async combine(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'scopeIds', 'unverified'])
    const sessionId = identity(request.sessionId)
    if (!Array.isArray(request.scopeIds) || typeof request.unverified !== 'boolean') throw new ExecutionIdentityError(400, 'invalid execution scopes')
    const ids = [...new Set(request.scopeIds.map(inputId))]
    return this.inRuntime(subject, async (client, subject) => {
      await this.session(client, subject, sessionId)
      const scopes = await Promise.all(ids.map(id => this.readScope(client, subject, sessionId, id)))
      return this.createScope(client, subject, sessionId, scopes.flatMap(scope => scope.input_ids),
        scopes.findLast(scope => scope.primary_actor_user_id !== null)?.primary_actor_user_id ?? null, request.unverified === true || scopes.some(scope => scope.unverified) || scopes.length === 0)
    })
  }

  private async assertCapturedScope(client: PoolClient, subject: ExecutionRuntimeSubject, scope: ExecutionScopeRow,
    inputs: string[], primary: number | undefined, unverified: unknown): Promise<void> {
    const state = await this.scopeState(client, subject, scope)
    if (JSON.stringify(state.inputs.toSorted()) !== JSON.stringify(inputs.toSorted())
      || state.primaryActorUserId !== primary || state.unverifiedHistory !== unverified) {
      throw new ExecutionIdentityError(403, 'captured execution differs from its immutable scope')
    }
  }

  private async readScope(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string, id: string): Promise<ExecutionScopeRow> {
    const rows = await subject.storage.db.query<ExecutionScopeRow>(`SELECT id,revision::text,input_ids,primary_actor_user_id,unverified
      FROM ${subject.storage.schema}.execution_scopes WHERE ${SESSION_SCOPE} AND id=$6`, [...scope(subject, sessionId), id])
    const row = rows.rows[0]
    if (row === undefined) throw new ExecutionIdentityError(403, 'execution scope belongs to another Session or runtime')
    return row
  }

  private async scopeState(client: PoolClient, subject: ExecutionRuntimeSubject, captured: ExecutionScopeRow): Promise<ExecutionIdentityState> {
    const receipts = await Promise.all(captured.input_ids.map(id => this.receipt(client, subject, undefined, id)))
    const actors = [...new Set(receipts.flatMap(receipt => receipt.actor_user_ids))]
    const primary = captured.primary_actor_user_id === null ? undefined : await this.publicActors(client, subject, [captured.primary_actor_user_id])
    return { scopeId: captured.id, revision: captured.revision, inputs: captured.input_ids,
      actors: await this.publicActors(client, subject, actors), unverifiedHistory: captured.unverified,
      ...(primary === undefined ? {} : { primaryActorUserId: primary[0]!.userId }) }
  }

  private async createScope(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string,
    inputs: string[], primary: string | null, unverified: boolean): Promise<ExecutionIdentityState> {
    const ids = [...new Set(inputs)].sort()
    const fingerprint = createHash('sha256').update(JSON.stringify({ ids, primary, unverified })).digest('hex')
    const existing = await subject.storage.db.query<ExecutionScopeRow>(`SELECT id,revision::text,input_ids,primary_actor_user_id,unverified
      FROM ${subject.storage.schema}.execution_scopes WHERE ${SESSION_SCOPE} AND fingerprint=$6`, [...scope(subject, sessionId), fingerprint])
    if (existing.rows[0] !== undefined) return this.scopeState(client, subject, existing.rows[0])
    const changed = await subject.storage.db.query<{ revision: string }>(`UPDATE ${subject.storage.schema}.execution_sessions SET revision=revision+1,updated_at=now()
      WHERE ${SESSION_SCOPE} RETURNING revision::text`, scope(subject, sessionId))
    await subject.storage.db.query(`INSERT INTO ${subject.storage.schema}.execution_scopes(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,fingerprint,revision,input_ids,primary_actor_user_id,unverified)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [...scope(subject, sessionId), fingerprint, changed.rows[0]!.revision, ids, primary, unverified])
    const rows = await subject.storage.db.query<ExecutionScopeRow>(`SELECT id,revision::text,input_ids,primary_actor_user_id,unverified
      FROM ${subject.storage.schema}.execution_scopes WHERE ${SESSION_SCOPE} AND fingerprint=$6`, [...scope(subject, sessionId), fingerprint])
    return this.scopeState(client, subject, rows.rows[0]!)
  }

  private inRuntime<T>(subject: RuntimeCredentialSubject, work: (client: PoolClient, owner: ExecutionRuntimeSubject) => Promise<T>): Promise<T> {
    return transaction(this.pool, async client => {
      const runtimeId = await this.runtimeIdentity(client, subject)
      const target = { ...subject.target, runtimeId }
      const binding = subject.contentBinding
      if (binding === undefined) return work(client, { ...subject, target, storage: { schema: 'harness', db: client } })
      if (this.nodeContent === undefined || binding.organizationId !== subject.organizationId || binding.runtimeId !== runtimeId
        || binding.nodeId !== this.nodeId || binding.projectId !== subject.projectInternalId || target.kind !== 'project') throw new NodeContentUnavailable()
      return this.nodeContent.write(binding, tx => work(client, { ...subject, target, storage: { schema: 'node_content', db: tx } }), subject.generation)
    })
  }

  private async runtimeIdentity(database: Queryable, subject: RuntimeCredentialSubject): Promise<RuntimeId> {
    if (subject.target.runtimeId !== undefined) return subject.target.runtimeId
    const result = await database.query<{ runtime_id: RuntimeId }>(`SELECT i.runtime_id FROM harness.instances i
      LEFT JOIN harness.users account ON account.organization_id=i.organization_id AND account.id=i.user_id
      LEFT JOIN harness.projects project ON project.organization_id=i.organization_id AND project.id=i.project_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.generation=$3
        AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=$4
        AND COALESCE(account.public_id,project.public_id)=$5 LIMIT 2`,
    [subject.organizationId, this.nodeId, subject.generation, subject.target.kind, subject.target.id])
    if (result.rows.length !== 1) throw new ExecutionIdentityError(409, 'execution requires an exact Runtime assignment')
    return result.rows[0]!.runtime_id
  }

  private async session(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string, lock = true): Promise<SessionRow> {
    const result = await subject.storage.db.query<SessionRow>(`SELECT revision::text,parent_session_id,is_seeded,actor_witnesses,
      primary_actor_user_id,unverified_history,inheritance_hash FROM ${subject.storage.schema}.execution_sessions
      WHERE ${SESSION_SCOPE}${lock ? ' FOR UPDATE' : ''}`, scope(subject, sessionId))
    const row = result.rows[0]
    if (row === undefined) throw new ExecutionIdentityError(404, 'execution Session is not registered in this runtime')
    return row
  }

  private async relatedSessions(client: PoolClient, subject: ExecutionRuntimeSubject, sender: string, receiver: string): Promise<[SessionRow, SessionRow]> {
    // Opposite-direction relays share lock ordering to avoid deadlock.
    const rows = await subject.storage.db.query<SessionRow & { session_id: string }>(`SELECT revision::text,session_id,parent_session_id,is_seeded,
      actor_witnesses,primary_actor_user_id,unverified_history,inheritance_hash FROM ${subject.storage.schema}.execution_sessions
      WHERE organization_id=$1 AND runtime_kind=$2 AND runtime_public_id=$3 AND session_id=ANY($4::text[]) AND runtime_id=$5
      ORDER BY session_id FOR UPDATE`, [subject.organizationId, subject.target.kind, subject.target.id, [sender, receiver],
      subject.target.runtimeId])
    const from = rows.rows.find(row => row.session_id === sender), to = rows.rows.find(row => row.session_id === receiver)
    if (from === undefined || to === undefined) throw new ExecutionIdentityError(404, 'execution Session is not registered in this runtime')
    return [from, to]
  }

  private async receipt(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string | undefined, id: string): Promise<InputRow> {
    const result = await subject.storage.db.query<InputRow>(`SELECT input.* FROM ${subject.storage.schema}.execution_inputs input
      WHERE input.id=$1 AND input.organization_id=$2 AND input.runtime_kind=$3 AND input.runtime_public_id=$4 AND input.runtime_id=$5`,
    [id, subject.organizationId, subject.target.kind, subject.target.id, subject.target.runtimeId])
    const row = result.rows[0]
    if (row === undefined || (sessionId !== undefined && row.session_id !== sessionId)) throw new ExecutionIdentityError(403, 'execution input belongs to another Session or runtime')
    return row
  }

  /**
   * Check the interactive user independently of the Session's model participants.
   * @param subject - authenticated runtime, including its current generation.
   * @param principal - signed interactive caller; restricted integration credentials cannot open terminals.
   * @param value - requested Session identity.
   * @returns the server-confirmed creator identity; administrator status grants no terminal bypass.
   */
  async authorizeTerminal(subject: RuntimeCredentialSubject, principal: GatewayPrincipalClaims, nodeId: string, value: unknown): Promise<{ userId: number; grantId: string }> {
    const request = object(value, ['sessionId'])
    const sessionId = identity(request.sessionId)
    return this.inRuntime(subject, async (client, subject) => {
      const actor = await this.principalActor(client, subject, sessionId, principal)
      await this.eligibleActors(client, subject, sessionId, [actor], 'user-terminal')
      const revisions = await this.terminalRevisions(client, subject, actor)
      const granted = await client.query<{ grant_id: string }>(`INSERT INTO harness.terminal_session_grants AS g
        (organization_id,node_id,runtime_kind,runtime_public_id,generation,session_id,user_id,user_policy_revision,project_policy_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(organization_id,node_id,runtime_kind,runtime_public_id,session_id,user_id) DO UPDATE SET
          grant_id=CASE WHEN g.generation=EXCLUDED.generation AND g.user_policy_revision=EXCLUDED.user_policy_revision
            AND g.project_policy_revision=EXCLUDED.project_policy_revision THEN g.grant_id ELSE gen_random_uuid() END,
          generation=EXCLUDED.generation,user_policy_revision=EXCLUDED.user_policy_revision,project_policy_revision=EXCLUDED.project_policy_revision
        WHERE g.generation<>EXCLUDED.generation OR g.user_policy_revision<>EXCLUDED.user_policy_revision
          OR g.project_policy_revision<>EXCLUDED.project_policy_revision
        RETURNING grant_id`, [subject.organizationId,nodeId,subject.target.kind,subject.target.id,subject.generation,sessionId,actor,revisions.user,revisions.project])
      const existing = granted.rows[0] === undefined ? await client.query<{ grant_id: string }>(`SELECT grant_id FROM harness.terminal_session_grants
        WHERE organization_id=$1 AND node_id=$2 AND runtime_kind=$3 AND runtime_public_id=$4 AND session_id=$5 AND user_id=$6`,
      [subject.organizationId,nodeId,subject.target.kind,subject.target.id,sessionId,actor]) : granted
      return { userId: principal.user.id, grantId: existing.rows[0]!.grant_id }
    })
  }

  /**
   * Recheck an existing terminal creator using a runtime-bound server grant.
   * @param subject - current authenticated runtime.
   * @param nodeId - receiving Gateway node.
   * @param value - Session and opaque grant previously issued to its interactive creator.
   * @returns current creator identity; a regrant cannot revive an old process.
   */
  async checkTerminal(subject: RuntimeCredentialSubject, nodeId: string, value: unknown): Promise<{ userId: number }> {
    const request = object(value, ['sessionId', 'grantId'])
    const sessionId = identity(request.sessionId), grantId = inputId(request.grantId)
    return this.inRuntime(subject, async (client, subject) => {
      const rows = await client.query<{ user_id: string; public_id: string; user_policy_revision: string; project_policy_revision: string }>(`SELECT g.user_id,u.public_id::text,
        g.user_policy_revision::text,g.project_policy_revision::text FROM harness.terminal_session_grants g
        JOIN harness.users u ON u.organization_id=g.organization_id AND u.id=g.user_id
        WHERE g.organization_id=$1 AND g.node_id=$2 AND g.runtime_kind=$3 AND g.runtime_public_id=$4
          AND g.generation=$5 AND g.session_id=$6 AND g.grant_id=$7 FOR SHARE OF g`,
      [subject.organizationId,nodeId,subject.target.kind,subject.target.id,subject.generation,sessionId,grantId])
      const grant = rows.rows[0]
      if (grant === undefined) throw new ExecutionIdentityError(403, 'terminal creator grant is unavailable')
      await this.eligibleActors(client, subject, sessionId, [grant.user_id], 'user-terminal')
      const revisions = await this.terminalRevisions(client, subject, grant.user_id)
      if (grant.user_policy_revision !== revisions.user || grant.project_policy_revision !== revisions.project) {
        throw new ExecutionIdentityError(403, 'terminal creator qualification changed')
      }
      return { userId: publicNumber(grant.public_id, 'terminal creator') }
    })
  }

  private async terminalRevisions(client: PoolClient, subject: ExecutionRuntimeSubject, actor: string): Promise<{ user: string; project: string }> {
    const rows = await client.query<{ user_id: string | null; revision: string }>(`SELECT user_id,revision::text FROM harness.terminal_access_policies
      WHERE organization_id=$1 AND (user_id=$2 OR project_id=$3) AND node_id=$4 AND enabled FOR SHARE`,
    [subject.organizationId,actor,subject.projectInternalId ?? null,this.nodeId])
    const user = rows.rows.find(row => row.user_id === actor)?.revision
    const project = subject.target.kind === 'user' ? '0' : rows.rows.find(row => row.user_id === null)?.revision
    if (user === undefined || project === undefined) throw new ExecutionIdentityError(403, 'terminal qualification is unavailable')
    return { user, project }
  }

  private async principalActor(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string, principal: GatewayPrincipalClaims): Promise<string> {
    if (principal.purpose !== undefined && principal.purpose !== 'webhook-dispatch') throw new ExecutionIdentityError(403, 'restricted-purpose principals cannot introduce execution inputs')
    const actor = await client.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [subject.organizationId, principal.user.id])
    const id = actor.rows[0]?.id
    if (id === undefined) throw new ExecutionIdentityError(403, 'execution actor is unavailable')
    await this.eligibleActors(client, subject, sessionId, [id], 'execute')
    return id
  }

  private async capturedPrimary(client: PoolClient, subject: ExecutionRuntimeSubject, receipts: InputRow[], primary: number): Promise<string> {
    const actors = [...new Set(receipts.flatMap(receipt => receipt.actor_user_ids))]
    const result = await client.query<{ id: string }>(`SELECT id FROM harness.users
      WHERE organization_id=$1 AND public_id=$2 AND id=ANY($3::uuid[])`, [subject.organizationId, primary, actors])
    const id = result.rows[0]?.id
    if (id === undefined) throw new ExecutionIdentityError(403, 'captured execution has an unrelated primary actor')
    return id
  }

  private async eligibleActors(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string, actorIds: string[], capability: Capability): Promise<void> {
    const result = await client.query<ActorRow>(`SELECT u.id,u.public_id::text,m.role
      ${capability === 'auto-review' ? ',u.auto_review_eligible' : ''}
      FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.organizations o ON o.id=u.organization_id
      WHERE u.organization_id=$1 AND u.id=ANY($2::uuid[]) AND u.status='active' AND u.deleted_at IS NULL
        AND m.status='active' AND o.status='active'
        AND harness.computer_use_allowed(u.organization_id,u.id,$3)
        FOR SHARE OF u,m`, [subject.organizationId, actorIds, this.nodeId])
    if (result.rows.length !== actorIds.length || result.rows.some(actor =>
      capability === 'auto-review' && actor.auto_review_eligible !== true)) {
      throw new ExecutionIdentityError(403, 'an execution actor is no longer eligible')
    }
    const resource = capability === 'plugin-management' ? 'plugin'
      : capability === 'desktop' ? 'desktop'
      : capability === 'ssh' ? 'ssh'
      : capability === 'memory' ? 'memory'
      : capability === 'user-terminal' ? 'terminal' : undefined
    if (resource !== undefined) {
      // Plugin management keeps administrators unqualified by policy; every
      // other actor needs an enabled grant, and a project target needs the
      // project's grant whenever any non-admin actor participates.
      const needed = capability === 'plugin-management'
        ? result.rows.filter(actor => actor.role !== 'admin').map(actor => actor.id)
        : actorIds
      if (needed.length > 0) {
        const users = await client.query<{ user_id: string }>(`SELECT user_id FROM harness.${resource}_access_policies
          WHERE organization_id=$1 AND user_id=ANY($2::uuid[]) AND node_id=$3 AND enabled FOR SHARE`, [subject.organizationId, needed, this.nodeId])
        if (users.rows.length !== needed.length) throw new ExecutionIdentityError(403, `an execution actor lacks ${resource} qualification`)
        if (subject.target.kind === 'project') {
          const project = await client.query(`SELECT 1 FROM harness.${resource}_access_policies
            WHERE organization_id=$1 AND project_id=$2 AND node_id=$3 AND enabled FOR SHARE`, [subject.organizationId, subject.projectInternalId, this.nodeId])
          if (project.rowCount !== 1) throw new ExecutionIdentityError(403, `${resource} access is not enabled for this project`)
        }
      }
    }
    if (subject.target.kind === 'user') {
      if (capability === 'memory') throw new ExecutionIdentityError(403, 'memory qualification applies only to project runtimes')
      if (result.rows.some(actor => publicNumber(actor.public_id, 'execution actor') !== subject.target.id)) throw new ExecutionIdentityError(403, 'personal execution cannot borrow another account')
      return
    }
    const { schema, db } = subject.storage
    if (schema === 'node_content') {
      const active = await client.query(`SELECT 1 FROM harness.projects p JOIN harness.project_content_placement b
        ON (b.organization_id,b.project_id)=(p.organization_id,p.id)
        WHERE p.organization_id=$1 AND p.id=$2 AND p.status='active' AND b.runtime_id=$3 AND b.node_id=$4
        AND b.volume_id=$5 AND b.writer_epoch=$6 FOR SHARE OF p,b`,
      [subject.organizationId,subject.projectInternalId,subject.target.runtimeId,this.nodeId,subject.contentBinding!.volumeId,subject.contentBinding!.writerEpoch])
      if (active.rowCount !== 1) throw new ExecutionIdentityError(403, 'project execution placement is unavailable')
    }
    const projectJoin = (table: 'c' | 'd'): string => schema === 'harness'
      ? `JOIN harness.projects p ON p.id=${table}.project_id AND p.organization_id=${table}.organization_id AND p.status='active'` : ''
    const projectLock = schema === 'harness' ? ',p' : ''
    const sessions = await db.query<{ visibility: string; creator_user_id: string }>(`SELECT r.visibility,r.creator_user_id
      FROM ${schema}.conversation_sessions c JOIN ${schema}.conversation_sessions r ON r.id=c.root_session_id AND r.organization_id=c.organization_id AND r.runtime_namespace=c.runtime_namespace
      ${projectJoin('c')}
      WHERE c.organization_id=$1 AND c.id=$2 AND c.runtime_id=$4 AND c.project_id=$3 AND c.status<>'deleted' AND r.status<>'deleted'
        FOR SHARE OF c,r${projectLock}`, [subject.organizationId, sessionId, subject.projectInternalId, subject.target.runtimeId])
    // An unmaterialized draft's write authority comes from its unexpired same-project
    // reservation, which names the creator and visibility.
    const session = sessions.rows[0] ?? (await db.query<{ visibility: string; creator_user_id: string | null }>(
      `SELECT d.visibility,d.user_id AS creator_user_id
        FROM ${schema}.conversation_draft_reservations d
        ${projectJoin('d')}
        WHERE d.organization_id=$1 AND d.session_id=$2 AND d.runtime_id=$4 AND d.project_id=$3
          AND d.lease_expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM ${schema}.conversation_sessions c
            WHERE c.organization_id=d.organization_id AND c.runtime_namespace=d.runtime_namespace AND c.id=d.session_id)
        FOR SHARE OF d${projectLock}`, [subject.organizationId, sessionId, subject.projectInternalId, subject.target.runtimeId])).rows[0]
    if (session === undefined) throw new ExecutionIdentityError(403, 'execution Session is not writable in this runtime')
    // Steward policy writers serialize with the actor locks held by this transaction.
    const project = await client.query(`SELECT 1 FROM harness.projects p
      WHERE p.organization_id=$1 AND p.id=$2 AND p.status='active'
        AND (p.kind='standard' OR (
          SELECT count(*) FROM harness.steward_access_policies sp
          JOIN harness.memberships m ON m.organization_id=sp.organization_id AND m.user_id=sp.user_id
          WHERE sp.organization_id=p.organization_id AND sp.node_id=$4 AND sp.enabled
            AND sp.user_id=ANY($3::uuid[]) AND m.role='admin'
        )=cardinality($3::uuid[]))`, [subject.organizationId, subject.projectInternalId, actorIds, this.nodeId])
    if (project.rowCount !== 1) throw new ExecutionIdentityError(403, 'project execution qualification is unavailable')
    if (capability === 'memory' && session.visibility === 'private') throw new ExecutionIdentityError(403, 'project memory is read-only in private conversations')
    const members = await client.query<{ user_id: string; access_mode: string }>(`SELECT user_id,access_mode FROM harness.project_members
      WHERE organization_id=$1 AND project_id=$2 AND user_id=ANY($3::uuid[]) FOR SHARE`,
    [subject.organizationId, subject.projectInternalId, actorIds])
    const writers = new Set(members.rows.filter(row => row.access_mode === 'rw').map(row => row.user_id))
    if (result.rows.some(actor => (capability === 'desktop' || capability === 'user-terminal' || actor.role !== 'admin') && (!writers.has(actor.id)
      || (session.visibility === 'private' && session.creator_user_id !== actor.id)))) {
      throw new ExecutionIdentityError(403, 'an execution actor cannot write this Session')
    }
  }

  private async insertInput(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string, messageId: string,
    kind: 'message' | 'question', hash: string, actor: string, previousId?: string): Promise<InputRow> {
    const previous = previousId === undefined ? undefined : await this.receipt(client, subject, sessionId, previousId)
    if (previous !== undefined && (previous.message_id !== messageId || previous.kind !== kind)) throw new ExecutionIdentityError(403, 'execution edit changes its input binding')
    const existing = await subject.storage.db.query<InputRow>(`SELECT * FROM ${subject.storage.schema}.execution_inputs WHERE ${SESSION_SCOPE}
      AND message_id=$6 AND kind=$7 AND previous_input_id IS NOT DISTINCT FROM $8::uuid
      ${previousId === undefined ? '' : 'AND created_by_user_id=$9 AND content_hash=$10'}`,
    [...scope(subject, sessionId), messageId, kind, previousId ?? null, ...previousId === undefined ? [] : [actor, hash]])
    const found = existing.rows[0]
    if (found !== undefined) {
      if (found.created_by_user_id !== actor || found.content_hash !== hash) throw new ExecutionIdentityError(409, 'execution input identity conflicts with an earlier admission')
      return found
    }
    const actors = [...new Set([...(previous?.actor_user_ids ?? []), actor])]
    const inserted = await subject.storage.db.query<InputRow>(`INSERT INTO ${subject.storage.schema}.execution_inputs(organization_id,runtime_kind,runtime_public_id,
      session_id,runtime_id,message_id,kind,content_hash,created_by_user_id,actor_user_ids,previous_input_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [...scope(subject, sessionId), messageId, kind, hash, actor, actors, previousId ?? null])
    return inserted.rows[0]!
  }

  private async merge(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string, state: SessionRow,
    receipts: InputRow[], primary: string | null, unverified: boolean): Promise<ExecutionIdentityState> {
    const witnesses = { ...state.actor_witnesses }
    for (const receipt of receipts) for (const actor of receipt.actor_user_ids) witnesses[actor] ??= receipt.id
    const changed = await subject.storage.db.query<{ revision: string }>(`UPDATE ${subject.storage.schema}.execution_sessions SET actor_witnesses=$6::jsonb,primary_actor_user_id=$7,
      unverified_history=unverified_history OR $8,revision=revision+1,updated_at=now() WHERE ${SESSION_SCOPE} RETURNING revision::text`,
    [...scope(subject, sessionId), JSON.stringify(witnesses), primary, unverified])
    return this.state(client, subject, { ...state, revision: changed.rows[0]!.revision, actor_witnesses: witnesses, primary_actor_user_id: primary,
      unverified_history: state.unverified_history || unverified })
  }

  private async replayTransfer(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string,
    state: SessionRow, unverified: boolean): Promise<ExecutionIdentityState> {
    return unverified && !state.unverified_history
      ? this.merge(client, subject, sessionId, state, [], state.primary_actor_user_id, true)
      : this.state(client, subject, state)
  }

  private async consume(client: PoolClient, subject: ExecutionRuntimeSubject, sessionId: string, state: SessionRow,
    receipt: InputRow, unverified: boolean): Promise<ExecutionIdentityState> {
    if (receipt.entered_at !== null) {
      if (unverified && !state.unverified_history) {
        return this.merge(client, subject, sessionId, state, [], state.primary_actor_user_id!, true)
      }
      return this.state(client, subject, state)
    }
    await subject.storage.db.query(`UPDATE ${subject.storage.schema}.execution_inputs SET entered_at=now() WHERE id=$1`, [receipt.id])
    return this.merge(client, subject, sessionId, state, [receipt], receipt.created_by_user_id, unverified)
  }

  private async publicActors(client: PoolClient, subject: ExecutionRuntimeSubject, actors: string[]): Promise<Array<{ userId: number }>> {
    const result = await client.query<{ public_id: string }>('SELECT public_id::text FROM harness.users WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY public_id', [subject.organizationId, actors])
    if (result.rows.length !== actors.length) throw new ExecutionIdentityError(403, 'execution actor record is unavailable')
    return result.rows.map(row => ({ userId: publicNumber(row.public_id, 'execution actor') }))
  }

  private async state(client: PoolClient, subject: ExecutionRuntimeSubject, state: SessionRow): Promise<ExecutionIdentityState> {
    const primary = state.primary_actor_user_id === null ? undefined : await this.publicActors(client, subject, [state.primary_actor_user_id])
    return { revision: state.revision, inputs: [...new Set(Object.values(state.actor_witnesses))].sort(),
      actors: await this.publicActors(client, subject, Object.keys(state.actor_witnesses)),
      ...(primary === undefined ? {} : { primaryActorUserId: primary[0]!.userId }), unverifiedHistory: state.unverified_history }
  }
}
