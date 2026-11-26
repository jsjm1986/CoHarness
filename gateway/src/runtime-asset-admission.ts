/** Current governance authority for an exact, already-running Runtime. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { UserRow } from './auth.ts'
import type { ProjectThemePolicy } from './collaboration.ts'
import type { PersonalReadAdmission } from './forwarded-principal.ts'
import type { RuntimeInstanceSnapshot } from './instances.ts'
import type { NodeProjectMetadata, ProjectContentRef } from './node-content-projects.ts'
import type { PrincipalScope } from './principal.ts'
import type { RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'
import type { RuntimePlacement } from './runtime-router.ts'
import type { ClusterMode } from './postgres/maintenance-service.ts'
import { nodePrincipalKeyQuery } from './postgres/node-principal-directory.ts'
import { publicNumber, type PostgresRuntimeContext } from './postgres/runtime-context.ts'

/** One parser-qualified read and its authenticated browser session. */
export interface RuntimeAssetRequest {
  actorId: number
  sessionToken: string
  runtimeId: RuntimeId
  /** Omission leaves node selection to the exact Runtime allocation. */
  nodeId?: RuntimeNodeId
  /** Omission leaves scope selection to the exact Runtime owner. */
  target?: RuntimePlacement['target']
  /** Verified forwarding issuer; direct requests use this Gateway's own ingress scope. */
  entryNodeId?: RuntimeNodeId
}

/** Qualified identity, placement, Runtime generation and revocation watermark for dispatch. */
export interface RuntimeAssetAdmission {
  user: UserRow
  scope: PrincipalScope
  placement: RuntimePlacement & { environment: NonNullable<RuntimePlacement['environment']> }
  snapshot: RuntimeInstanceSnapshot
  accessRevision: string
  /** Earliest unchanged login or managed-node lease deadline, in epoch milliseconds. */
  expiresAt: number
}

/** Stable HTTP refusal for an already-supervised Runtime dispatch. */
export class RuntimeAssetUnavailableError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503, readonly code: string) {
    super(code)
    this.name = 'RuntimeAssetUnavailableError'
  }
}

interface Row {
  public_id: string
  username: string
  display_name: string
  role: 'admin' | 'member'
  home_path: string
  auto_review_eligible: boolean
  owner_kind: 'user' | 'project'
  owner_public_id: string
  node_id: RuntimeNodeId
  node_name: string
  node_status: 'active' | 'draining' | 'offline'
  last_heartbeat_at: string | null
  generation: string
  observed_state: string
  stop_reason: string | null
  provisioning_state: 'preparing' | 'ready'
  port: number
  launch_stamp: string | null
  started_at: number
  access_revision: string
  available: boolean
  expires_at: number
  project_kind: 'standard' | 'steward' | null
  project_mode: 'ro' | 'rw' | null
  can_manage: boolean
  legacy_project_name: string | null
  legacy_project_path: string | null
  project_content: ProjectContentRef['content']
  project_theme_policy: ProjectThemePolicy | null
  cluster_mode: ClusterMode
  write_epoch: string
}

interface SessionAdmissionRow {
  admission: { initial: Row | null; current: Row | null; accepted: boolean | null }
  issuer_revision?: string
  issuer_lease_exp?: Date | null
}

const admissionSnapshot = 'harness.browser_runtime_admission_snapshot($1,$2,$3,$4,$5)'

function sharedSessionAdmissionSql(issuer: string): string {
  const snapshotWithIssuer = issuer === '' ? '' : ', issuer_revision, issuer_lease_exp'
  return `WITH ${issuer === '' ? '' : `${issuer}, `}initial AS MATERIALIZED (
      SELECT ${admissionSnapshot} snapshot${snapshotWithIssuer}${issuer === '' ? '' : ' FROM issuer'}
    ), locked AS MATERIALIZED (
      SELECT i.runtime_id FROM initial
      JOIN harness.instances i ON i.organization_id=$1 AND i.runtime_id=$4 AND i.assigned_node_id=$6 AND i.generation=$7
      WHERE (initial.snapshot->>'available')::boolean
        AND (initial.snapshot->>'owner_kind'='user' AND $8::text='personal'
          OR initial.snapshot->>'owner_kind'='project'
            AND $8::text='project:'||(initial.snapshot->>'owner_public_id'))
        AND initial.snapshot->>'cluster_mode'='serving' AND (initial.snapshot->>'write_epoch')::bigint=$9
        AND i.observed_state='ready' AND i.provisioning_state='ready'
      FOR SHARE OF i
    ) SELECT jsonb_build_object('initial', initial.snapshot,
      'accepted', CASE WHEN locked.runtime_id IS NOT NULL THEN true END,
      'current', CASE WHEN locked.runtime_id IS NOT NULL THEN ${admissionSnapshot} END
    ) admission${snapshotWithIssuer} FROM initial LEFT JOIN locked ON true`
}

/** PostgreSQL read qualification with the same organization, computer and project predicates as browser admission. */
export class PostgresRuntimeAssetAdmission {
  constructor(private readonly context: PostgresRuntimeContext, private readonly writeEpoch: bigint,
    private readonly nodeProjects?: Pick<NodeProjectMetadata, 'lookup'>) {}

  /**
   * Read current session, owner, computer, project, generation and lease authority in one statement.
   * @param request - exact parser-qualified target and browser session; no forwarded assertion replaces these reads.
   * @returns current identity and ready generation without renewing the session or writing activity.
   */
  async admit(request: RuntimeAssetRequest): Promise<RuntimeAssetAdmission> {
    const result = await this.context.pool.query<{ snapshot: Row | null }>(
      `SELECT ${admissionSnapshot} snapshot`, this.parameters(request))
    return this.admission(request, result.rows[0]!.snapshot ?? undefined)
  }

  /**
   * Qualify one personal Runtime read at the organization database's primary Gateway.
   * @param request - exact target and browser identity for this forwarding attempt.
   * @param issuerPublicKey - public part of the key this Gateway uses to sign the request.
   * @returns the ready generation and current revision, or null when normal routing is required.
   */
  async approvePersonalRead(request: RuntimeAssetRequest & { nodeId: RuntimeNodeId; target: 'personal' },
    issuerPublicKey: string): Promise<PersonalReadAdmission | null> {
    const { rows: [result] } = await this.context.pool.query<{ snapshot: Row | null; lease_exp: Date | null }>(`
      SELECT ${admissionSnapshot} snapshot, issuer.lease_exp
      FROM harness.deployment_topology topology
      JOIN (${nodePrincipalKeyQuery(5)}) issuer ON issuer.pem=$6
      WHERE topology.organization_id=$1 AND topology.enabled AND topology.primary_node_id=$5`,
    [...this.parameters({ ...request, entryNodeId: this.context.nodeId as RuntimeNodeId }), issuerPublicKey])
    try {
      const row = result?.snapshot ?? undefined
      this.assertServing(row)
      const admission = this.admission(request, row)
      const { state, generation, port, launchStamp, startedAt } = admission.snapshot
      const expiresAt = Math.min(admission.expiresAt, result?.lease_exp?.getTime() ?? Infinity)
      if (state !== 'ready' || admission.scope.kind !== 'personal' || expiresAt <= Date.now()) return null
      return { generation, port, launchStamp, startedAt, expiresAt, accessRevision: admission.accessRevision }
    } catch (error) {
      if (error instanceof RuntimeAssetUnavailableError) return null
      throw error
    }
  }

  /**
   * Recheck browser authority after locking the retained instance. A node-local
   * project read also verifies its volume and rechecks governance before dispatch.
   * @param request - authenticated browser request for this computer and one exact Runtime and scope.
   * @param generation - generation owned by the local supervisor after queued lifecycle work.
   * @param issuer - verified signature key and issuer UUID requiring current publication in this statement.
   * @param recordStartActivity - defaults to recording activity at admission. Prepared personal requests and project
   *   reads can use a shared lock while the supervisor retains the Runtime through completion.
   * @returns current authority or null when the existing general preparation route must handle this request.
   */
  async admitSession(request: RuntimeAssetRequest & { nodeId: RuntimeNodeId; target: RuntimePlacement['target'] },
    generation: number, issuer?: { nodeId: RuntimeNodeId; publicKey: string }, recordStartActivity = true): Promise<RuntimeAssetAdmission | null> {
    const nodeProjects = request.target !== 'personal' && !recordStartActivity ? this.nodeProjects : undefined
    const shareInstanceLock = !recordStartActivity && (request.target === 'personal' || nodeProjects !== undefined)
    const parameters = [...this.parameters(issuer === undefined ? request : { ...request, entryNodeId: issuer.nodeId }),
      request.nodeId, generation, request.target, ...(shareInstanceLock ? [] : [Date.now()]), String(this.writeEpoch)]
    const admit = 'SELECT harness.admit_ready_browser_runtime($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) admission'
    const issuerSql = issuer === undefined ? '' : `issuer AS MATERIALIZED (
          SELECT o.access_revision::text issuer_revision, key.lease_exp issuer_lease_exp
          FROM (${nodePrincipalKeyQuery(5)}) key
          JOIN harness.organizations o ON o.id=$1 AND o.status='active'
          WHERE key.pem=$${parameters.length + 1}
        )`
    const sql = shareInstanceLock ? sharedSessionAdmissionSql(issuerSql)
      : issuer === undefined ? admit : `WITH ${issuerSql} ${admit}, issuer_revision, issuer_lease_exp FROM issuer`
    const { rows: [result] } = await this.context.pool.query<SessionAdmissionRow>(sql,
      issuer === undefined ? parameters : [...parameters, issuer.publicKey])
    if (result === undefined) throw new RuntimeAssetUnavailableError(403, 'access-revoked')
    const { initial, current, accepted } = result.admission
    this.assertServing(initial ?? undefined)
    if (accepted === null) return null
    const row = current ?? undefined
    this.assertServing(row)
    if (!accepted && row !== undefined) return null
    if (row !== undefined && result.issuer_revision !== undefined && row.access_revision !== result.issuer_revision) {
      throw new RuntimeAssetUnavailableError(409, 'RUNTIME_LEASE_UNAVAILABLE')
    }
    const admission = this.admission(request, row)
    if (admission.snapshot.generation !== generation) throw new RuntimeAssetUnavailableError(409, 'RUNTIME_LEASE_UNAVAILABLE')
    if (result.issuer_lease_exp != null) admission.expiresAt = Math.min(admission.expiresAt, result.issuer_lease_exp.getTime())
    if (admission.scope.kind === 'personal') return admission
    if (row?.project_content != null && nodeProjects !== undefined) {
      return this.admitNodeProjectRead(request, admission, initial ?? undefined, row.project_content, nodeProjects, issuer)
    }
    if (row?.legacy_project_name == null) return null
    if (row.legacy_project_path !== initial?.legacy_project_path) throw new RuntimeAssetUnavailableError(403, 'access-revoked')
    return { ...admission, scope: { ...admission.scope, projectName: row.legacy_project_name } }
  }

  private async admitNodeProjectRead(request: RuntimeAssetRequest, admitted: RuntimeAssetAdmission, initial: Row | undefined,
    binding: NonNullable<ProjectContentRef['content']>, nodeProjects: Pick<NodeProjectMetadata, 'lookup'>,
    issuer?: { nodeId: RuntimeNodeId; publicKey: string }): Promise<RuntimeAssetAdmission> {
    const retained = admitted.snapshot
    if (!admitted.placement.local || binding.runtimeId !== request.runtimeId || binding.nodeId !== request.nodeId
      || !isDeepStrictEqual(initial?.project_content, binding)) {
      throw new RuntimeAssetUnavailableError(403, 'access-revoked')
    }
    const display = (await nodeProjects.lookup([{ content: binding }], retained.generation)).get(binding.projectId)!
    // No governance connection remains locked while the node reads its volume.
    const scopedRequest = issuer === undefined ? request : { ...request, entryNodeId: issuer.nodeId }
    const baseParameters = this.parameters(scopedRequest)
    const recheckSql = issuer === undefined
      ? `SELECT ${admissionSnapshot} snapshot`
      : `WITH issuer AS MATERIALIZED (
          SELECT o.access_revision::text issuer_revision, key.lease_exp issuer_lease_exp
          FROM (${nodePrincipalKeyQuery(5)}) key
          JOIN harness.organizations o ON o.id=$1 AND o.status='active'
          WHERE key.pem=$6
        ) SELECT ${admissionSnapshot} snapshot, issuer_revision, issuer_lease_exp FROM issuer`
    const { rows: [result] } = await this.context.pool.query<{
      snapshot: Row | null; issuer_revision?: string; issuer_lease_exp?: Date | null
    }>(recheckSql, issuer === undefined ? baseParameters : [...baseParameters, issuer.publicKey])
    if (result === undefined) throw new RuntimeAssetUnavailableError(403, 'access-revoked')
    const row = result.snapshot ?? undefined
    this.assertServing(row)
    if (row !== undefined && result.issuer_revision !== undefined && row.access_revision !== result.issuer_revision) {
      throw new RuntimeAssetUnavailableError(409, 'RUNTIME_LEASE_UNAVAILABLE')
    }
    if (!isDeepStrictEqual(row?.project_content, binding)) {
      throw new RuntimeAssetUnavailableError(403, 'access-revoked')
    }
    const current = this.admission(request, row)
    if (result.issuer_lease_exp != null) current.expiresAt = Math.min(current.expiresAt, result.issuer_lease_exp.getTime())
    if (current.accessRevision !== admitted.accessRevision || current.scope.kind !== 'project'
      || current.snapshot.generation !== retained.generation
      || current.snapshot.port !== retained.port || current.snapshot.launchStamp !== retained.launchStamp
      || current.snapshot.startedAt !== retained.startedAt) {
      throw new RuntimeAssetUnavailableError(409, 'RUNTIME_LEASE_UNAVAILABLE')
    }
    const theme = row?.project_theme_policy
    return { ...current, expiresAt: Math.min(admitted.expiresAt, current.expiresAt),
      scope: { ...current.scope, projectName: display.name, ...(theme == null ? {} : { uiThemePolicy: theme }) } }
  }

  private assertServing(row: Row | undefined): void {
    if (row === undefined) return
    if (row.write_epoch !== String(this.writeEpoch)) throw new RuntimeAssetUnavailableError(503, 'stale-epoch')
    if (row.cluster_mode !== 'serving') throw new RuntimeAssetUnavailableError(503, 'maintenance')
  }

  private parameters(request: RuntimeAssetRequest): [string, Buffer, number, RuntimeId, string] {
    return [this.context.organizationId, createHash('sha256').update(request.sessionToken).digest(), request.actorId,
      request.runtimeId, request.entryNodeId ?? this.context.nodeId]
  }

  private admission(request: RuntimeAssetRequest, row: Row | undefined): RuntimeAssetAdmission {
    if (row === undefined) throw new RuntimeAssetUnavailableError(403, 'runtime-asset/forbidden')
    const ownerId = publicNumber(row.owner_public_id, 'Runtime asset owner')
    const target = row.owner_kind === 'user' ? 'personal' : `project:${ownerId}` as const
    if (request.nodeId !== undefined && request.nodeId !== row.node_id || request.target !== undefined && request.target !== target) {
      throw new RuntimeAssetUnavailableError(409, 'runtime-asset/target-mismatch')
    }
    if (row.observed_state !== 'ready' && row.stop_reason === 'manual') throw new RuntimeAssetUnavailableError(409, 'INSTANCE_STOPPED')
    if (!row.available) throw new RuntimeAssetUnavailableError(503, 'runtime-asset/unavailable')
    const generation = publicNumber(row.generation, 'Runtime asset generation')
    const user: UserRow = { id: publicNumber(row.public_id, 'Runtime asset actor'), username: row.username,
      displayName: row.display_name, role: row.role === 'admin' ? 'admin' : 'user', status: 'active',
      homePath: row.home_path, mustChangePassword: false, autoReviewEligible: row.auto_review_eligible }
    return { user, accessRevision: row.access_revision, expiresAt: Math.floor(row.expires_at),
      scope: row.owner_kind === 'user' ? { kind: 'personal' } : { kind: 'project', projectId: ownerId,
        projectName: `#${ownerId}`, mode: row.project_mode!, canManage: row.can_manage,
        ...(row.project_kind === 'steward' ? { steward: true } : {}) },
      placement: { target, local: row.node_id === this.context.nodeId, resetScope: false,
        environment: { id: request.runtimeId, owner: { kind: row.owner_kind === 'user' ? 'personal' : 'project', id: ownerId, name: `#${ownerId}` },
          node: { id: row.node_id, name: row.node_name, status: row.node_status, lastHeartbeatAt: row.last_heartbeat_at === null ? null : new Date(row.last_heartbeat_at).toISOString() },
          routing: row.node_id === this.context.nodeId ? 'local' : 'unavailable', observedState: row.observed_state,
          generation, provisioning: row.provisioning_state } },
      snapshot: { target: { kind: row.owner_kind, id: ownerId, runtimeId: request.runtimeId }, state: row.observed_state,
        port: row.port, generation, launchStamp: row.launch_stamp, startedAt: row.started_at },
    }
  }
}
