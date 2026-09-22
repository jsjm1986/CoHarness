/** PostgreSQL records of authenticated execution inputs and current actor eligibility. @module */

import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { GatewayAccessMonitor } from './access-invalidation.ts'
import { transaction, type Queryable } from './postgres/database.ts'
import type { ConversationHeader } from './postgres/conversation-repository.ts'
import { publicNumber } from './postgres/runtime-context.ts'
import type { GatewayPrincipalClaims } from './principal.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'

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
type Capability = 'execute' | 'plugin-management' | 'auto-review'
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

function scope(subject: RuntimeCredentialSubject, sessionId: string): [string, string, number, string] {
  return [subject.organizationId, subject.target.kind, subject.target.id, sessionId]
}

const SESSION_SCOPE = 'organization_id=$1 AND runtime_kind=$2 AND runtime_public_id=$3 AND session_id=$4'

/**
 * Validate delayed usage attribution against immutable inputs, not present-day eligibility.
 * @param database - the caller's existing accounting transaction or database connection
 * @param input - runtime-owned Session, captured witness subset, and one primary actor
 * @returns completion when every witness and the primary actor belong to the recorded execution
 */
export async function verifyExecutionAttribution(database: Queryable, input: {
  organizationId: string
  runtime: { kind: 'user' | 'project'; id: number }
  sessionId: string
  inputIds: readonly string[]
  primaryActorUserId: number
}): Promise<void> {
  const sessionId = identity(input.sessionId)
  if (!Array.isArray(input.inputIds) || input.inputIds.length === 0
    || !Number.isSafeInteger(input.primaryActorUserId) || input.primaryActorUserId <= 0
    || (input.runtime.kind === 'user' && input.primaryActorUserId !== input.runtime.id)) {
    throw new ExecutionIdentityError(403, 'execution attribution requires witnesses and a primary actor')
  }
  const ids = [...new Set(input.inputIds.map(inputId))]
  const state = await database.query<{ actor_witnesses: Record<string, string> }>(
    `SELECT actor_witnesses FROM harness.execution_sessions WHERE ${SESSION_SCOPE}`,
    [input.organizationId, input.runtime.kind, input.runtime.id, sessionId],
  )
  const recorded = new Set(Object.values(state.rows[0]?.actor_witnesses ?? {}))
  if (ids.some(id => !recorded.has(id))) throw new ExecutionIdentityError(403, 'execution attribution contains an unentered input')
  const inputs = await database.query<{ actor_user_ids: string[] }>(`SELECT actor_user_ids FROM harness.execution_inputs
    WHERE organization_id=$1 AND runtime_kind=$2 AND runtime_public_id=$3 AND id=ANY($4::uuid[])`,
  [input.organizationId, input.runtime.kind, input.runtime.id, ids])
  if (inputs.rows.length !== ids.length) throw new ExecutionIdentityError(403, 'execution attribution belongs to another runtime')
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
 */
export function watchExecutionAccess(monitor: GatewayAccessMonitor, response: ServerResponse, heartbeatMs: number): void {
  let heartbeat: NodeJS.Timeout | undefined
  let closed = false
  const write = (event: unknown): void => {
    if (response.destroyed || response.writableEnded) return
    // A slow consumer loses its stream and must recheck authority on reconnect.
    // Do not retain an application queue or await transport drain in the monitor.
    if (!response.write(`${JSON.stringify(event)}\n`)) response.destroy()
  }
  const unsubscribe = monitor.subscribe((subject) => {
    if (subject.userId === undefined && subject.projectId === undefined) response.destroy()
    else write({ type: 'invalidate', ...subject })
  })
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
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
    heartbeat = setInterval(() => { write({ type: 'heartbeat' }) }, heartbeatMs)
    heartbeat.unref()
  }
}

/** Keeps immutable input facts separate from fresh, revocable eligibility decisions. */
export class GatewayExecutionIdentity {
  constructor(private readonly pool: Pool) {}

  /**
   * Register immutable Session lineage without granting any execution authority.
   * @param subject - authenticated current runtime
   * @param value - parsed wire metadata
   * @param header - PostgreSQL metadata already checked against the project runtime, if applicable
   */
  async register(subject: RuntimeCredentialSubject, value: unknown, header?: ConversationHeader): Promise<void> {
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
    await transaction(this.pool, async (client) => {
      if (parent !== undefined) await this.session(client, subject, parent, false)
      await client.query(`INSERT INTO harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,parent_session_id,is_seeded)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [...scope(subject, sessionId), parent ?? null, seeded])
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
    const request = object(value, ['sessionId'])
    const sessionId = identity(request.sessionId)
    return transaction(this.pool, async client => this.state(client, subject, await this.session(client, subject, sessionId, false)))
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
    return transaction(this.pool, async (client) => {
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
    const request = object(value, ['sessionId', 'inputId', 'messageId', 'contentHash', 'creationAuthorization', 'unverifiedHistory'])
    const sessionId = identity(request.sessionId), id = inputId(request.inputId)
    const messageId = identity(request.messageId), hash = contentHash(request.contentHash)
    if (request.unverifiedHistory !== undefined && typeof request.unverifiedHistory !== 'boolean') throw new ExecutionIdentityError(400, 'invalid unverified history flag')
    return transaction(this.pool, async (client) => {
      const state = await this.session(client, subject, sessionId)
      const receipt = await this.receipt(client, subject, sessionId, id)
      if (receipt.message_id !== messageId || receipt.content_hash !== hash) throw new ExecutionIdentityError(403, 'execution input does not match the entered message')
      return this.consume(client, subject, sessionId, state, receipt, request.unverifiedHistory === true)
    })
  }

  /**
   * Inherit only recorded parent witnesses after immutable lineage has been checked.
   * @param subject - authenticated runtime
   * @param value - child, real parent, and the delegation-time witness subset
   * @returns the child's canonical actor set
   */
  async inherit(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'parentSessionId', 'inputs', 'primaryActorUserId', 'unverifiedHistory'])
    const sessionId = identity(request.sessionId), parentId = identity(request.parentSessionId)
    if (sessionId === parentId || !Array.isArray(request.inputs)) throw new ExecutionIdentityError(400, 'invalid execution inheritance')
    const inputs = [...new Set(request.inputs.map(inputId))]
    const captured = primaryActor(request.primaryActorUserId)
    if (inputs.length === 0 ? captured !== undefined || request.unverifiedHistory !== true : captured === undefined) {
      throw new ExecutionIdentityError(400, 'execution inheritance requires a primary actor or explicit empty unknown history')
    }
    await this.markUnverified(subject, sessionId, request.unverifiedHistory)
    const hash = transferHash(parentId, inputs, captured, request.unverifiedHistory === true)
    return transaction(this.pool, async (client) => {
      const [parent, child] = await this.relatedSessions(client, subject, parentId, sessionId)
      if (child.parent_session_id !== parentId) throw new ExecutionIdentityError(403, 'execution inheritance requires the registered parent')
      const unverified = parent.unverified_history || request.unverifiedHistory === true
      if (child.inheritance_hash !== null) {
        if (child.inheritance_hash !== hash) throw new ExecutionIdentityError(409, 'execution inheritance conflicts with its first admission')
        return this.replayTransfer(client, subject, sessionId, child, unverified)
      }
      const witnesses = new Set(Object.values(parent.actor_witnesses))
      if (inputs.some(id => !witnesses.has(id))) throw new ExecutionIdentityError(403, 'execution input was not entered by the parent')
      if (inputs.length === 0 && witnesses.size !== 0) throw new ExecutionIdentityError(403, 'empty inheritance cannot omit recorded parent actors')
      const receipts = await Promise.all(inputs.map(id => this.receipt(client, subject, undefined, id)))
      const primary = captured === undefined ? null : await this.capturedPrimary(client, subject, receipts, captured)
      await client.query(`UPDATE harness.execution_sessions SET inheritance_hash=$5 WHERE ${SESSION_SCOPE}`, [...scope(subject, sessionId), hash])
      return this.merge(client, subject, sessionId, child, receipts, child.primary_actor_user_id ?? primary, unverified)
    })
  }

  /**
   * Merge a Host-captured adjacent-Agent relay without borrowing unrelated Session evidence.
   * @param subject - authenticated runtime shared by both Sessions
   * @param value - receiver, real adjacent sender, and the sender's captured witnesses
   * @returns receiver authority after the monotonic merge
   */
  async relay(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'senderSessionId', 'messageId', 'inputs', 'primaryActorUserId', 'unverifiedHistory'])
    const sessionId = identity(request.sessionId), senderId = identity(request.senderSessionId), messageId = identity(request.messageId)
    if (sessionId === senderId || !Array.isArray(request.inputs)) throw new ExecutionIdentityError(400, 'invalid execution relay')
    const inputs = [...new Set(request.inputs.map(inputId))]
    const captured = primaryActor(request.primaryActorUserId)
    if (inputs.length === 0 ? captured !== undefined || request.unverifiedHistory !== true : captured === undefined) {
      throw new ExecutionIdentityError(400, 'execution relay requires a primary actor or explicit empty unknown history')
    }
    await this.markUnverified(subject, sessionId, request.unverifiedHistory)
    const hash = transferHash(senderId, inputs, captured, request.unverifiedHistory === true)
    return transaction(this.pool, async (client) => {
      const [sender, receiver] = await this.relatedSessions(client, subject, senderId, sessionId)
      if (sender.parent_session_id !== sessionId && receiver.parent_session_id !== senderId) {
        throw new ExecutionIdentityError(403, 'execution relay requires adjacent parent and child Sessions')
      }
      const unverified = sender.unverified_history || request.unverifiedHistory === true
      const previous = await client.query<{ request_hash: string }>(`SELECT request_hash FROM harness.execution_relays
        WHERE ${SESSION_SCOPE} AND message_id=$5`, [...scope(subject, sessionId), messageId])
      if (previous.rows[0] !== undefined) {
        if (previous.rows[0].request_hash !== hash) throw new ExecutionIdentityError(409, 'execution relay conflicts with its first admission')
        return this.replayTransfer(client, subject, sessionId, receiver, unverified)
      }
      const witnesses = new Set(Object.values(sender.actor_witnesses))
      if (inputs.some(id => !witnesses.has(id))) throw new ExecutionIdentityError(403, 'execution relay contains an unentered sender input')
      if (inputs.length === 0 && witnesses.size !== 0) throw new ExecutionIdentityError(403, 'empty relay cannot omit recorded sender actors')
      const receipts = await Promise.all(inputs.map(id => this.receipt(client, subject, undefined, id)))
      const primary = captured === undefined ? receiver.primary_actor_user_id : await this.capturedPrimary(client, subject, receipts, captured)
      await client.query(`INSERT INTO harness.execution_relays(organization_id,runtime_kind,runtime_public_id,session_id,message_id,request_hash)
        VALUES($1,$2,$3,$4,$5,$6)`, [...scope(subject, sessionId), messageId, hash])
      return this.merge(client, subject, sessionId, receiver, receipts, primary, unverified)
    })
  }

  /**
   * Authorize from server-owned witnesses and current account/Session permissions.
   * @param subject - authenticated runtime
   * @param value - Session and requested capability, never caller-supplied actors
   * @returns the canonical set only when every actor remains eligible
   */
  async authorize(subject: RuntimeCredentialSubject, value: unknown): Promise<ExecutionIdentityState> {
    const request = object(value, ['sessionId', 'capability', 'unverifiedHistory'])
    const sessionId = identity(request.sessionId), capability = request.capability
    if (capability !== 'execute' && capability !== 'plugin-management' && capability !== 'auto-review') throw new ExecutionIdentityError(400, 'invalid execution capability')
    await this.markUnverified(subject, sessionId, request.unverifiedHistory)
    return transaction(this.pool, async (client) => {
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
    await transaction(this.pool, async (client) => {
      const state = await this.session(client, subject, sessionId)
      if (state.unverified_history) throw new ExecutionIdentityError(403, 'execution selection requires verified history')
      const selector = await this.principalActor(client, subject, sessionId, principal)
      await this.eligibleActors(client, subject, sessionId, [...new Set([selector, ...Object.keys(state.actor_witnesses)])], capability)
    })
  }

  private async markUnverified(subject: RuntimeCredentialSubject, sessionId: string, unverified: unknown): Promise<void> {
    if (unverified !== undefined && typeof unverified !== 'boolean') throw new ExecutionIdentityError(400, 'invalid unverified history flag')
    if (unverified !== true) return
    // The reported uncertainty survives a subsequent authorization refusal.
    // Keep this commit outside the transaction whose result may be a denial.
    await this.pool.query(`UPDATE harness.execution_sessions SET unverified_history=true,revision=revision+1,updated_at=now()
      WHERE ${SESSION_SCOPE} AND NOT unverified_history`, scope(subject, sessionId))
  }

  /**
   * Claim one authenticated human answer and merge its input in the same transaction.
   * @param subject - authenticated runtime
   * @param principal - verified current answerer
   * @param value - the Host-validated pending question and normalized JSON answer
   * @returns an idempotent claim and the canonical execution set
   */
  async question(subject: RuntimeCredentialSubject, principal: GatewayPrincipalClaims, value: unknown): Promise<ExecutionIdentityState & { claimed: true }> {
    const request = object(value, ['sessionId', 'questionId', 'answer'])
    const sessionId = identity(request.sessionId), questionId = identity(request.questionId)
    const answer = JSON.stringify(request.answer)
    if (answer === undefined) throw new ExecutionIdentityError(400, 'invalid execution question answer')
    const hash = createHash('sha256').update(answer).digest('hex')
    return transaction(this.pool, async (client) => {
      const state = await this.session(client, subject, sessionId)
      const actor = await this.principalActor(client, subject, sessionId, principal)
      if (subject.target.kind === 'project') {
        const root = await client.query<{ root_session_id: string }>(
          'SELECT root_session_id FROM harness.conversation_sessions WHERE organization_id=$1 AND id=$2', [subject.organizationId, sessionId],
        )
        const rootId = root.rows[0]?.root_session_id
        if (rootId === undefined) throw new ExecutionIdentityError(404, 'execution question Session is unavailable')
        await client.query(`INSERT INTO harness.conversation_interaction_responses(
          organization_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome)
          VALUES($1,'question',$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
        [subject.organizationId, questionId, rootId, actor, answer])
        const claim = await client.query(`SELECT 1 FROM harness.conversation_interaction_responses
          WHERE organization_id=$1 AND interaction_kind='question' AND interaction_id=$2
            AND conversation_id=$3 AND responder_user_id=$4 AND outcome=$5::jsonb`,
        [subject.organizationId, questionId, rootId, actor, answer])
        if (claim.rowCount !== 1) throw new ExecutionIdentityError(409, 'execution question was claimed by another response')
      }
      const receipt = await this.insertInput(client, subject, sessionId, questionId, 'question', hash, actor)
      return { claimed: true, ...await this.consume(client, subject, sessionId, state, receipt, false) }
    })
  }

  private async session(client: PoolClient, subject: RuntimeCredentialSubject, sessionId: string, lock = true): Promise<SessionRow> {
    const result = await client.query<SessionRow>(`SELECT revision::text,parent_session_id,is_seeded,actor_witnesses,
      primary_actor_user_id,unverified_history,inheritance_hash FROM harness.execution_sessions WHERE ${SESSION_SCOPE}${lock ? ' FOR UPDATE' : ''}`, scope(subject, sessionId))
    const row = result.rows[0]
    if (row === undefined) throw new ExecutionIdentityError(404, 'execution Session is not registered in this runtime')
    return row
  }

  private async relatedSessions(client: PoolClient, subject: RuntimeCredentialSubject, sender: string, receiver: string): Promise<[SessionRow, SessionRow]> {
    // Opposite-direction relays share lock ordering to avoid deadlock.
    const rows = await client.query<SessionRow & { session_id: string }>(`SELECT revision::text,session_id,parent_session_id,is_seeded,
      actor_witnesses,primary_actor_user_id,unverified_history,inheritance_hash FROM harness.execution_sessions
      WHERE organization_id=$1 AND runtime_kind=$2 AND runtime_public_id=$3 AND session_id=ANY($4::text[])
      ORDER BY session_id FOR UPDATE`, [subject.organizationId, subject.target.kind, subject.target.id, [sender, receiver]])
    const from = rows.rows.find(row => row.session_id === sender), to = rows.rows.find(row => row.session_id === receiver)
    if (from === undefined || to === undefined) throw new ExecutionIdentityError(404, 'execution Session is not registered in this runtime')
    return [from, to]
  }

  private async receipt(client: PoolClient, subject: RuntimeCredentialSubject, sessionId: string | undefined, id: string): Promise<InputRow> {
    const result = await client.query<InputRow>(`SELECT * FROM harness.execution_inputs WHERE id=$1
      AND organization_id=$2 AND runtime_kind=$3 AND runtime_public_id=$4`,
    [id, subject.organizationId, subject.target.kind, subject.target.id])
    const row = result.rows[0]
    if (row === undefined || (sessionId !== undefined && row.session_id !== sessionId)) throw new ExecutionIdentityError(403, 'execution input belongs to another Session or runtime')
    return row
  }

  private async principalActor(client: PoolClient, subject: RuntimeCredentialSubject, sessionId: string, principal: GatewayPrincipalClaims): Promise<string> {
    if (principal.purpose !== undefined) throw new ExecutionIdentityError(403, 'restricted-purpose principals cannot introduce execution inputs')
    const actor = await client.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [subject.organizationId, principal.user.id])
    const id = actor.rows[0]?.id
    if (id === undefined) throw new ExecutionIdentityError(403, 'execution actor is unavailable')
    await this.eligibleActors(client, subject, sessionId, [id], 'execute')
    return id
  }

  private async capturedPrimary(client: PoolClient, subject: RuntimeCredentialSubject, receipts: InputRow[], primary: number): Promise<string> {
    const actors = [...new Set(receipts.flatMap(receipt => receipt.actor_user_ids))]
    const result = await client.query<{ id: string }>(`SELECT id FROM harness.users
      WHERE organization_id=$1 AND public_id=$2 AND id=ANY($3::uuid[])`, [subject.organizationId, primary, actors])
    const id = result.rows[0]?.id
    if (id === undefined) throw new ExecutionIdentityError(403, 'captured execution has an unrelated primary actor')
    return id
  }

  private async eligibleActors(client: PoolClient, subject: RuntimeCredentialSubject, sessionId: string, actorIds: string[], capability: Capability): Promise<void> {
    const result = await client.query<ActorRow>(`SELECT u.id,u.public_id::text,m.role
      ${capability === 'auto-review' ? ',u.auto_review_eligible' : ''}
      FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.organizations o ON o.id=u.organization_id
      WHERE u.organization_id=$1 AND u.id=ANY($2::uuid[]) AND u.status='active' AND u.deleted_at IS NULL
        AND m.status='active' AND o.status='active' FOR SHARE OF u,m`, [subject.organizationId, actorIds])
    if (result.rows.length !== actorIds.length || result.rows.some(actor =>
      (capability === 'plugin-management' && actor.role !== 'admin')
      || (capability === 'auto-review' && actor.auto_review_eligible !== true))) {
      throw new ExecutionIdentityError(403, 'an execution actor is no longer eligible')
    }
    if (subject.target.kind === 'user') {
      if (result.rows.some(actor => publicNumber(actor.public_id, 'execution actor') !== subject.target.id)) throw new ExecutionIdentityError(403, 'personal execution cannot borrow another account')
      return
    }
    const sessions = await client.query<{ visibility: string; creator_user_id: string }>(`SELECT r.visibility,r.creator_user_id
      FROM harness.conversation_sessions c JOIN harness.conversation_sessions r ON r.id=c.root_session_id AND r.organization_id=c.organization_id
      JOIN harness.projects p ON p.id=c.project_id AND p.organization_id=c.organization_id
      WHERE c.organization_id=$1 AND c.id=$2 AND c.project_id=$3 AND c.status<>'deleted' AND r.status<>'deleted'
        AND p.status='active' FOR SHARE OF c,r,p`, [subject.organizationId, sessionId, subject.projectInternalId])
    const session = sessions.rows[0]
    if (session === undefined) throw new ExecutionIdentityError(403, 'execution Session is not writable in this runtime')
    const members = await client.query<{ user_id: string; access_mode: string }>(`SELECT user_id,access_mode FROM harness.project_members
      WHERE organization_id=$1 AND project_id=$2 AND user_id=ANY($3::uuid[]) FOR SHARE`,
    [subject.organizationId, subject.projectInternalId, actorIds])
    const writers = new Set(members.rows.filter(row => row.access_mode === 'rw').map(row => row.user_id))
    if (result.rows.some(actor => actor.role !== 'admin' && (!writers.has(actor.id)
      || (session.visibility === 'private' && session.creator_user_id !== actor.id)))) {
      throw new ExecutionIdentityError(403, 'an execution actor cannot write this Session')
    }
  }

  private async insertInput(client: PoolClient, subject: RuntimeCredentialSubject, sessionId: string, messageId: string,
    kind: 'message' | 'question', hash: string, actor: string, previousId?: string): Promise<InputRow> {
    const previous = previousId === undefined ? undefined : await this.receipt(client, subject, sessionId, previousId)
    if (previous !== undefined && (previous.message_id !== messageId || previous.kind !== kind)) throw new ExecutionIdentityError(403, 'execution edit changes its input binding')
    const existing = await client.query<InputRow>(`SELECT * FROM harness.execution_inputs WHERE ${SESSION_SCOPE}
      AND message_id=$5 AND kind=$6 AND previous_input_id IS NOT DISTINCT FROM $7::uuid
      ${previousId === undefined ? '' : 'AND created_by_user_id=$8 AND content_hash=$9'}`,
    [...scope(subject, sessionId), messageId, kind, previousId ?? null, ...previousId === undefined ? [] : [actor, hash]])
    const found = existing.rows[0]
    if (found !== undefined) {
      if (found.created_by_user_id !== actor || found.content_hash !== hash) throw new ExecutionIdentityError(409, 'execution input identity conflicts with an earlier admission')
      return found
    }
    const actors = [...new Set([...(previous?.actor_user_ids ?? []), actor])]
    const inserted = await client.query<InputRow>(`INSERT INTO harness.execution_inputs(organization_id,runtime_kind,runtime_public_id,
      session_id,message_id,kind,content_hash,created_by_user_id,actor_user_ids,previous_input_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [...scope(subject, sessionId), messageId, kind, hash, actor, actors, previousId ?? null])
    return inserted.rows[0]!
  }

  private async merge(client: PoolClient, subject: RuntimeCredentialSubject, sessionId: string, state: SessionRow,
    receipts: InputRow[], primary: string | null, unverified: boolean): Promise<ExecutionIdentityState> {
    const witnesses = { ...state.actor_witnesses }
    for (const receipt of receipts) for (const actor of receipt.actor_user_ids) witnesses[actor] ??= receipt.id
    const changed = await client.query<{ revision: string }>(`UPDATE harness.execution_sessions SET actor_witnesses=$5::jsonb,primary_actor_user_id=$6,
      unverified_history=unverified_history OR $7,revision=revision+1,updated_at=now() WHERE ${SESSION_SCOPE} RETURNING revision::text`,
    [...scope(subject, sessionId), JSON.stringify(witnesses), primary, unverified])
    return this.state(client, subject, { ...state, revision: changed.rows[0]!.revision, actor_witnesses: witnesses, primary_actor_user_id: primary,
      unverified_history: state.unverified_history || unverified })
  }

  private async replayTransfer(client: PoolClient, subject: RuntimeCredentialSubject, sessionId: string,
    state: SessionRow, unverified: boolean): Promise<ExecutionIdentityState> {
    return unverified && !state.unverified_history
      ? this.merge(client, subject, sessionId, state, [], state.primary_actor_user_id, true)
      : this.state(client, subject, state)
  }

  private async consume(client: PoolClient, subject: RuntimeCredentialSubject, sessionId: string, state: SessionRow,
    receipt: InputRow, unverified: boolean): Promise<ExecutionIdentityState> {
    if (receipt.entered_at !== null) {
      if (unverified && !state.unverified_history) {
        return this.merge(client, subject, sessionId, state, [], state.primary_actor_user_id!, true)
      }
      return this.state(client, subject, state)
    }
    await client.query('UPDATE harness.execution_inputs SET entered_at=now() WHERE id=$1', [receipt.id])
    return this.merge(client, subject, sessionId, state, [receipt], receipt.created_by_user_id, unverified)
  }

  private async publicActors(client: PoolClient, subject: RuntimeCredentialSubject, actors: string[]): Promise<Array<{ userId: number }>> {
    const result = await client.query<{ public_id: string }>('SELECT public_id::text FROM harness.users WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY public_id', [subject.organizationId, actors])
    if (result.rows.length !== actors.length) throw new ExecutionIdentityError(403, 'execution actor record is unavailable')
    return result.rows.map(row => ({ userId: publicNumber(row.public_id, 'execution actor') }))
  }

  private async state(client: PoolClient, subject: RuntimeCredentialSubject, state: SessionRow): Promise<ExecutionIdentityState> {
    const primary = state.primary_actor_user_id === null ? undefined : await this.publicActors(client, subject, [state.primary_actor_user_id])
    return { revision: state.revision, inputs: [...new Set(Object.values(state.actor_witnesses))].sort(),
      actors: await this.publicActors(client, subject, Object.keys(state.actor_witnesses)),
      ...(primary === undefined ? {} : { primaryActorUserId: primary[0]!.userId }), unverifiedHistory: state.unverified_history }
  }
}
