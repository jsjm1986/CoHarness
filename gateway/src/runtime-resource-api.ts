/** Authenticated node admission; permits account for resources and never confer execution privileges. @module */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import {
  RESOURCE_CHANGE_CURSOR_HEADER, RESOURCE_MESSAGE_MAX_BYTES, RESOURCE_PHASE_TIMING_HEADER, RESOURCE_QUALIFIED_GRANT_HEADER,
  resourceFinishSchema, resourceRequestSchema, resourceStatusesSchema,
  type ResourceOrigin, type ResourceStatus, type ResourceWireRequest,
} from '@deepseek-ai/dsh-resource-budget/wire'
import { ExecutionIdentityError, type GatewayExecutionIdentity, type PersonalExecutionWriteFence } from './execution-identity.ts'
import { NodeResourceBudgetError, type NodeResourceAdmission, type NodeResourceBudget } from './node-resource-budget.ts'
import type { GatewayPrincipalClaims, GatewayPrincipalSigner } from './principal.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'

interface Dependencies {
  readonly pool: Pool
  readonly principals: GatewayPrincipalSigner
  readonly execution: GatewayExecutionIdentity
  readonly budget: NodeResourceBudget
  readonly personalFence?: PersonalExecutionWriteFence
  readonly fencedRequest?: ScopedModelRequest
  readonly waitForQueued?: boolean
  readonly bearerMs?: number
}

type SessionOrigin = Extract<ResourceOrigin, { kind: 'session' }>
type ScopedModelRequest = ResourceWireRequest & { kind: 'model'; origin: Required<SessionOrigin> }

function boundedResourcePayload(body: string): unknown {
  if (Buffer.byteLength(body) > RESOURCE_MESSAGE_MAX_BYTES) return
  try { return JSON.parse(body) as unknown } catch (error) {
    if (error instanceof SyntaxError) return
    throw error
  }
}

/**
 * Qualify a bounded personal model submission for database-verified admission.
 * @param body - bounded Runtime API body.
 * @returns Scoped model metadata; other submissions retain ordinary bearer and write admission.
 */
export function scopedModelResourceRequest(body: string): ScopedModelRequest | undefined {
  const result = resourceRequestSchema.safeParse(boundedResourcePayload(body))
  if (!result.success) return
  const { kind, origin } = result.data
  if (kind === 'model' && origin.kind === 'session' && origin.scopeId !== undefined && Buffer.byteLength(origin.sessionId) <= 256) {
    return { ...result.data, kind, origin: { ...origin, scopeId: origin.scopeId } }
  }
}

/**
 * Select one exact bounded operation for active model confirmation.
 * @param body - bounded Runtime API body.
 * @returns the single operation reference, or undefined for ordinary status admission.
 */
export function activeModelStatusOperation(body: string): Pick<ResourceWireRequest, 'sequence' | 'requestId'> | undefined {
  const result = resourceStatusesSchema.safeParse(boundedResourcePayload(body))
  if (result.success && result.data.operations.length === 1) return result.data.operations[0]
}

function assertNeverOrigin(_origin: never): never {
  throw new Error('unsupported resource origin')
}

/** Resolve queue ownership from immutable scopes or a freshly eligible signed actor. */
async function actor(deps: Dependencies, subject: RuntimeCredentialSubject, origin: ResourceOrigin): Promise<{
  actorId: number; administrative: boolean
}> {
  switch (origin.kind) {
    case 'runtime':
      // Agentless project maintenance shares one infrastructure turn across projects.
      return { actorId: subject.target.kind === 'user' ? subject.target.id : 0, administrative: false }
    case 'session': {
      const state = await authorizeSession(deps, subject, origin)
      if (state.primaryActorUserId === undefined) throw new ExecutionIdentityError(403, 'resource execution has no primary actor')
      return { actorId: state.primaryActorUserId, administrative: false }
    }
    case 'principal': {
      let claims: GatewayPrincipalClaims
      try { claims = deps.principals.verify(origin.assertion) } catch {
        // Signature and expiry failures carry no usable principal identity.
        throw new ExecutionIdentityError(403, 'invalid resource principal')
      }
      const administrative = claims.purpose === 'document-admin' || claims.purpose === 'plugin-admin' || claims.purpose === 'terminal-admin'
      if (claims.runtime.kind !== subject.target.kind || claims.runtime.id !== subject.target.id
        || claims.runtime.generation !== subject.generation || claims.runtime.runtimeId !== subject.target.runtimeId
        || (claims.purpose !== undefined && !administrative)
        || (subject.target.kind === 'user' && (claims.scope.kind !== 'personal'
          || (claims.user.id !== subject.target.id && !administrative)))
        || (subject.target.kind === 'project' && (claims.scope.kind !== 'project' || claims.scope.projectId !== subject.target.id))) {
        throw new ExecutionIdentityError(403, 'resource principal does not belong to this runtime')
      }
      await eligibleActor(deps, subject, claims.user.id, administrative)
      return { actorId: claims.user.id, administrative }
    }
  }
  return assertNeverOrigin(origin)
}

async function eligibleActor(deps: Dependencies, subject: RuntimeCredentialSubject, actorId: number, administrative: boolean): Promise<void> {
  const eligible = await deps.pool.query<{ role: string }>(`SELECT m.role FROM harness.users u
        JOIN harness.memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id
        JOIN harness.organizations o ON o.id=u.organization_id
        LEFT JOIN harness.runtime_environments environment ON environment.organization_id=u.organization_id AND environment.id=$5
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
          AND m.status='active' AND o.status='active'
          AND ($4::boolean OR harness.computer_use_allowed(u.organization_id,u.id,environment.node_id))
          AND ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM harness.projects p WHERE p.organization_id=u.organization_id AND p.id=$3 AND p.status='active'
              AND (p.kind='standard' AND (m.role='admin' OR EXISTS (
                SELECT 1 FROM harness.project_members pm
                WHERE pm.organization_id=p.organization_id AND pm.project_id=p.id AND pm.user_id=u.id))
              OR p.kind='steward' AND m.role='admin' AND EXISTS (
                SELECT 1 FROM harness.steward_access_policies sp
                WHERE sp.organization_id=p.organization_id AND sp.user_id=u.id AND sp.node_id=environment.node_id AND sp.enabled))))`,
  [subject.organizationId, actorId, subject.projectInternalId ?? null, administrative, subject.target.runtimeId ?? null])
  if (eligible.rows.length !== 1 || (administrative && eligible.rows[0]?.role !== 'admin')) {
    throw new ExecutionIdentityError(403, 'resource principal is no longer eligible')
  }
}

async function authorizeSession(deps: Dependencies, subject: RuntimeCredentialSubject, origin: {
  sessionId: string; scopeId?: string
}) {
  if (origin.scopeId === undefined) {
    if (await deps.execution.hasScopes(subject, origin.sessionId)) throw new ExecutionIdentityError(403, 'resource execution requires its immutable scope')
  }
  return deps.execution.authorize(subject, { sessionId: origin.sessionId, scopeId: origin.scopeId, capability: 'execute' }, deps.personalFence)
}

/** Recheck stored ownership after the node transaction releases its database connection. */
async function qualifiedStatus(deps: Dependencies, subject: RuntimeCredentialSubject, admission: NodeResourceAdmission): Promise<ResourceStatus> {
  if (admission.status.state !== 'active' && admission.status.state !== 'queued') return admission.status
  const origin = admission.origin
  if (origin === undefined) return { state: 'refused', reason: 'authority-unavailable' }
  try {
    switch (origin.kind) {
      case 'runtime': break
      case 'principal': await eligibleActor(deps, subject, origin.actorId, origin.administrative); break
      case 'session': await authorizeSession(deps, subject, origin); break
      default: return assertNeverOrigin(origin)
    }
    return admission.status
  } catch (error) {
    if (error instanceof ExecutionIdentityError && (error.status === 403 || error.status === 404)) {
      return { state: 'refused', reason: 'authority-unavailable' }
    }
    throw error
  }
}

/**
 * Route bounded Runtime resource messages after bearer authentication.
 * @param deps - node coordinator and existing execution/principal authorities.
 * @param subject - current generation; finish alone also accepts its stopping state.
 * @param req - authenticated HTTP request.
 * @param res - response receiving identifier-free accounting results.
 * @param pathname - parsed URL pathname.
 * @param body - bounded JSON request bytes.
 * @returns true for a resource endpoint, including invalid methods and messages.
 */
export async function handleRuntimeResourceApi(
  deps: Dependencies, subject: RuntimeCredentialSubject, req: IncomingMessage, res: ServerResponse,
  pathname: string, body: string,
): Promise<boolean> {
  if (!pathname.startsWith('/internal/runtime/resources/')) return false
  const send = (status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const round = (ms: number): number => Math.round(ms * 100) / 100
  const { bearerMs } = deps
  const timing = bearerMs === undefined ? undefined : (authorityMs: number, transactionMs: number): void => {
    res.setHeader(RESOURCE_PHASE_TIMING_HEADER, JSON.stringify([round(bearerMs), round(authorityMs), round(transactionMs)]))
  }
  if (req.method !== 'POST') { send(405, { error: 'resource-method' }); return true }
  if (Buffer.byteLength(body) > RESOURCE_MESSAGE_MAX_BYTES) { send(413, { error: 'resource-message-too-large' }); return true }
  try {
    const payload: unknown = deps.fencedRequest ?? JSON.parse(body)
    switch (pathname.slice('/internal/runtime/resources/'.length)) {
      case 'register':
        z.object({}).strict().parse(payload)
        send(200, await deps.budget.register(subject))
        return true
      case 'request': {
        const request = deps.fencedRequest ?? resourceRequestSchema.parse(payload)
        const started = timing === undefined ? 0 : performance.now()
        const fence = deps.fencedRequest === undefined ? undefined : deps.personalFence
        const scopedModel = request.kind === 'model' && request.origin.kind === 'session' && request.origin.scopeId !== undefined
        const cursor = deps.waitForQueued === true && (fence !== undefined || scopedModel) ? deps.budget.changeCursor : undefined
        const attribution = fence === undefined ? await actor(deps, subject, request.origin)
          : { actorId: subject.target.id, administrative: false }
        const authorized = timing === undefined ? 0 : performance.now()
        let status = await deps.budget.request(subject, {
          sequence: request.sequence, requestId: request.requestId, kind: request.kind, ...attribution, origin: request.origin.kind,
          projectId: subject.target.kind === 'project' ? subject.target.id : 0,
          ...(request.origin.kind === 'session' ? { sessionId: request.origin.sessionId, scopeId: request.origin.scopeId } : {}),
        }, fence)
        if (cursor !== undefined && status.state === 'queued') res.setHeader(RESOURCE_CHANGE_CURSOR_HEADER, cursor)
        if (fence !== undefined && status.state === 'active') {
          res.setHeader(RESOURCE_QUALIFIED_GRANT_HEADER, '1')
        } else if (fence === undefined && scopedModel && status.state === 'active' && request.origin.kind === 'session') {
          // Confirm post-reservation scope authority in-process so project and
          // node_content model grants avoid a second /resources/statuses HTTP round trip.
          try {
            await authorizeSession(deps, subject, request.origin)
            res.setHeader(RESOURCE_QUALIFIED_GRANT_HEADER, '1')
          } catch (error) {
            if (error instanceof ExecutionIdentityError && (error.status === 403 || error.status === 404)) {
              status = { state: 'refused', reason: 'authority-unavailable' }
            } else {
              throw error
            }
          }
        }
        timing?.(authorized - started, performance.now() - authorized)
        send(200, status)
        return true
      }
      case 'statuses': {
        const request = resourceStatusesSchema.parse(payload)
        const started = timing === undefined ? 0 : performance.now()
        const admissions = await deps.budget.admissions(subject, request.operations)
        const observed = timing === undefined ? 0 : performance.now()
        const statuses: ResourceStatus[] = []
        for (const admission of admissions) statuses.push(await qualifiedStatus(deps, subject, admission))
        timing?.(performance.now() - observed, observed - started)
        send(200, statuses)
        return true
      }
      case 'finish': {
        const request = resourceFinishSchema.parse(payload)
        await deps.budget.finish(subject, request, request.outcome)
        send(200, {})
        return true
      }
      default:
        send(404, { error: 'resource-endpoint' })
        return true
    }
  } catch (error) {
    if (deps.fencedRequest !== undefined && error instanceof Error && 'code' in error) {
      if (error.code === 'P4101') throw new ExecutionIdentityError(403, 'personal execution is no longer authorized')
      if (error.code === 'P4104') throw new ExecutionIdentityError(503, 'execution writes are unavailable')
    }
    if (error instanceof NodeResourceBudgetError) send(error.status, { error: `resource-${error.reason}` })
    else if (error instanceof z.ZodError || error instanceof SyntaxError) send(400, { error: 'resource-message' })
    else throw error
    return true
  }
}
