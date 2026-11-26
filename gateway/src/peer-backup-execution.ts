/** Node-verified disaster execution permits retain restored conversations as read-only history. */
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { GatewayConfig } from './config.ts'
import type { RuntimeLaunchContext, RuntimeTarget } from './instances.ts'
import type { NodeContentStore } from './node-content-store.ts'
import { readRecoveryExecutionPolicy } from './peer-backup-execution-data.ts'
import { PeerBackupError, peerPrivateDirectory } from './peer-backup-repository.ts'
import { PeerProjectRecovery, type PeerRecoveryOperation } from './peer-backup-takeover.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import { policyPatchText } from './launch-stamp.ts'
import { PeerProjectFileGate } from './peer-backup-file-gate.ts'
import { checkPeerBackupNode } from './peer-backup-governance.ts'
import { lockRecoveryOwner } from './peer-backup-takeover-authority.ts'
import { transferredRecoverySessions } from './peer-backup-execution-transfer.ts'
import { lockPersonalRecoveryOwner, type PeerPersonalRecovery, type PeerPersonalRecoveryOperation } from './peer-backup-personal-recovery.ts'
import type { GovernanceExecutionOperation, GovernanceRecoveryExecutionAdapter } from './governance-rebuild-execution-protocol.ts'

/** Safe management metadata; configuration bodies remain on the target computer. */
export interface RecoveryExecutionItem {
  id: string
  kind: 'plugin' | 'external-connection'
  name: string
  itemDigest: string
  artifactSha256: string
  configurationSha256: string
  status: 'suspended' | 'eligible' | 'approved'
  reason?: string
}

interface ReviewRow {
  id: string
  policyDigest: string
  compositionDigest: string
  oldSessionCount: number
  items: RecoveryExecutionItem[]
  blockers: string[]
}
interface RequestRow {
  requestId: string
  status: 'queued' | 'ready' | 'failed'
  reviewId: string | null
  errorCode: string | null
}

interface CompositionInspection {
  compositionDigest: string
  composition: { version: 1; rows: Array<{ name: string; entrySha256: string; artifactSha256: string; configurationSha256: string; dependencyClosure?: true }>;
    connections?: Array<{kind: 'mcp' | 'hook'; id: string; configurationSha256: string}> }
  items: RecoveryExecutionItem[]
  blockers: string[]
}
interface RecoveryPolicy {
  version: 1
  mode: 'new-conversations-only'
  operationId: string
  pointId: string
  runtimeId: string
  nodeId: string
  writerEpoch: string
  reviewRevision: string
  oldSessionIds: string[]
  approvedItems: string[]
  compositionDigest: string
  composition: CompositionInspection['composition']
}
interface RecoveryInspector {
  inspectRecoveryProfile(input: {home: string; profileDir: string; cwd: string; installAnchor: string; trustedPatchFiles: string[];
    trustedPatchText: string; trustedPackageDirectories: string[]; presetFiles: string[];
    approvedItems: readonly string[]}): Promise<CompositionInspection> | CompositionInspection
}

type ExecutionOperation = PeerRecoveryOperation | PeerPersonalRecoveryOperation | GovernanceExecutionOperation
function governanceOperation(op:ExecutionOperation):op is GovernanceExecutionOperation{return 'recoveryScope' in op}
function operationKind(op:ExecutionOperation):'user'|'project'{return governanceOperation(op)?op.ownerKind:'accountId' in op?'user':'project'}
function operationPublicId(op:ExecutionOperation):number{return 'accountId' in op?op.userId:op.publicId}

/** A personal data owner supplies only its verified local files; project and personal receipts remain separate. */
export interface PersonalRecoveryExecutionAdapter {
  service: PeerPersonalRecovery
  paths(op: PeerPersonalRecoveryOperation): Promise<{home: string; cwd: string; admin: boolean}>
  oldSessions(op: PeerPersonalRecoveryOperation): Promise<string[]>
}

/** Node-local dependencies; the primary needs only context for management actions. */
export interface PeerRecoveryExecutionOptions {
  context: PostgresRuntimeContext
  personal?: PersonalRecoveryExecutionAdapter
  governance?: GovernanceRecoveryExecutionAdapter
  config?: GatewayConfig
  volume?: Pick<NodeContentStore, 'readVolume'>
  maxRows?: number
  maxBytes?: number
  /** Prepare the existing managed profile without starting a Runtime or stopping work. */
  prepareProfile?: (target: RuntimeTarget) => Promise<void>
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function deny(code: string): never { throw new PeerBackupError(409, 'peer-backup/' + code) }
const confirmation = z.object({ confirm: z.uuid() }).strict()
const reviewConfirmation = z.object({ confirm: z.uuid(), reviewRevision: z.uuid(), mode: z.literal('new-conversations-only') }).strict()
const itemConfirmation = z.object({ confirm: z.uuid(), reviewRevision: z.uuid(), itemDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceReference: z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value) && !/:\/\/[^/\s]*@/u.test(value)) }).strict()

/** Preserve immutable review receipts while independently controlling admission of new work. */
export class PeerRecoveryExecution {
  private readonly context: PostgresRuntimeContext
  private readonly recovery: Pick<PeerProjectRecovery, 'get'> | Pick<PeerPersonalRecovery, 'get'> | Pick<GovernanceRecoveryExecutionAdapter,'get'>
  constructor(private readonly options: PeerRecoveryExecutionOptions) {
    this.context = options.context
    this.recovery = options.governance ?? options.personal?.service ?? new PeerProjectRecovery(options.context)
  }

  private table(part: 'operations' | 'execution_holds' | 'execution_requests' | 'execution_reviews' | 'execution_approvals' | 'execution_item_approvals'): string {
    if(this.options.governance)return 'harness.governance_rebuild_'+(part==='operations'?'runtimes':part)
    return 'harness.' + (this.options.personal ? 'personal' : 'project') + '_recovery_' + part
  }

  private async admin<T>(actor: number, work: (tx: PoolClient) => Promise<T>, op?: ExecutionOperation): Promise<T> {
    if(this.options.governance)return this.options.governance.authorize(actor,work,op&&governanceOperation(op)?op:undefined)
    return transaction(this.context.pool, async tx => {
      await lockAdministrator(tx, this.context, actor)
      await tx.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1) ON CONFLICT DO NOTHING', [this.context.organizationId])
      const entry = (await tx.query<{enabled: boolean; primaryNode: string}>(`SELECT t.enabled,t.primary_node_id "primaryNode"
        FROM harness.deployment_topology t JOIN harness.cluster_control c USING(organization_id)
        JOIN harness.compute_nodes n ON n.organization_id=t.organization_id AND n.id=$2
        WHERE t.organization_id=$1 AND c.mode='serving' AND n.status='active'
          AND NOT EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=t.organization_id AND q.node_id=n.id)
        FOR SHARE OF t,c,n`, [this.context.organizationId, this.context.nodeId])).rows[0]
      if (!entry || entry.enabled && entry.primaryNode !== this.context.nodeId) deny('primary-required')
      if (!entry.enabled && op) {
        if (op.targetNode !== this.context.nodeId) deny('execution-target-not-local')
        await this.lockPublished(tx, op, false)
      }
      return work(tx)
    })
  }

  private async nodeReady(tx: PoolClient, op: ExecutionOperation): Promise<void> {
    if(governanceOperation(op)){if(!this.options.governance)deny('execution-not-provisioned');return this.options.governance.nodeReady(tx,op)}
    const topology = (await tx.query<{enabled: boolean}>(`SELECT t.enabled FROM harness.deployment_topology t
      JOIN harness.cluster_control c USING(organization_id) WHERE t.organization_id=$1 AND c.mode='serving'
      AND harness.node_execution_available($1,$2) FOR SHARE OF t,c`, [op.organizationId, op.targetNode])).rows[0]
    if (!topology || op.targetNode !== this.context.nodeId) deny('node-not-admitted')
    if (topology.enabled) await checkPeerBackupNode(tx, op.organizationId, op.targetNode, true)
  }

  private async audit(tx: PoolClient, actor: number, action: string, id: string): Promise<void> {
    const scope = this.options.governance?'governance-rebuild':this.options.personal ? 'personal-recovery' : 'project-recovery'
    await tx.query(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,detail)
      SELECT $1,u.id,$3,$5,$4,'{}' FROM harness.users u WHERE u.organization_id=$1 AND u.public_id=$2`,
    [this.context.organizationId, actor, 'admin.' + scope + '.execution-' + action, id, scope])
  }

  private async lockPublished(tx: PoolClient, op: ExecutionOperation, stopped: boolean): Promise<void> {
    if(governanceOperation(op)){if(!this.options.governance)deny('execution-not-provisioned');return this.options.governance.lock(tx,op,stopped)}
    if ('accountId' in op) {
      const personal = (await tx.query<{stopped: boolean}>(`SELECT i.observed_state='stopped' AND i.desired_state='stopped'
        AND i.runtime_token_hash IS NULL stopped FROM harness.personal_recovery_operations r
        JOIN harness.personal_recovery_execution_holds h ON h.operation_id=r.id AND h.organization_id=r.organization_id
        JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
        JOIN harness.personal_directory_placement p ON p.organization_id=r.organization_id AND p.runtime_id=r.runtime_id
        WHERE r.organization_id=$1 AND r.id=$2 AND r.phase='published' AND r.target_activated_at IS NOT NULL
          AND i.user_id=r.user_id AND i.assigned_node_id=r.target_node_id AND i.generation>=r.target_epoch
          AND p.owner_id=r.user_id AND p.node_id=r.target_node_id FOR UPDATE OF r,i,p`, [op.organizationId, op.id])).rows[0]
      if (!personal) deny('execution-not-published')
      if (stopped && !personal.stopped) deny('execution-runtime-busy')
      if (stopped) await lockPersonalRecoveryOwner(tx, op)
      return
    }
    const row = (await tx.query<{ stopped: boolean }>(`SELECT i.observed_state='stopped' AND i.desired_state='stopped'
      AND i.runtime_token_hash IS NULL stopped FROM ${this.table('operations')} r
      JOIN ${this.table('execution_holds')} h ON h.operation_id=r.id AND h.organization_id=r.organization_id
      JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
      JOIN harness.project_content_placement p ON p.organization_id=r.organization_id AND p.project_id=r.project_id
      WHERE r.organization_id=$1 AND r.id=$2 AND r.phase='published' AND r.target_activated_at IS NOT NULL
      AND (p.runtime_id,p.node_id,p.volume_id,p.writer_epoch)=(r.runtime_id,r.target_node_id,r.target_volume_id,r.target_epoch)
      AND i.assigned_node_id=r.target_node_id FOR UPDATE OF r,i,p`, [this.context.organizationId, op.id])).rows[0]
    if (!row) deny('execution-not-published')
    if (stopped && !row.stopped) deny('execution-runtime-busy')
    if (stopped) await lockRecoveryOwner(tx, op)
  }

  private async request(tx: Pick<PoolClient, 'query'>, id: string): Promise<RequestRow | undefined> {
    return (await tx.query<RequestRow>(`SELECT request_id "requestId",status,review_id "reviewId",error_code "errorCode"
      FROM ${this.table('execution_requests')} WHERE organization_id=$1 AND operation_id=$2`, [this.context.organizationId, id])).rows[0]
  }

  private async review(tx: Pick<PoolClient, 'query'>, id: string): Promise<ReviewRow | undefined> {
    return (await tx.query<ReviewRow>(`SELECT id,policy_digest "policyDigest",composition_digest "compositionDigest",
      old_session_count::float8 "oldSessionCount",items,blockers FROM ${this.table('execution_reviews')}
      WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, id])).rows[0]
  }

  /** Read the current review without touching content or waking the target.
   * @param actor - authenticated administrator. @param id - immutable recovery operation.
   * @returns sanitized progress and exact item digests for subsequent confirmations.
   */
  async status(actor: number, id: string) {
    const op = await this.recovery.get(id)
    return this.admin(actor, async tx => {
      const request = await this.request(tx, id)
      const review = request?.reviewId ? await this.review(tx, request.reviewId) : undefined
      const enabled = request?.status === 'ready' && review && (await tx.query(`SELECT FROM ${this.table('execution_approvals')}
        WHERE organization_id=$1 AND review_id=$2 AND harness.recovery_execution_allowed($1,$3,$4)`,
      [this.context.organizationId, review.id, op.runtimeId, op.targetNode])).rowCount === 1
      return { recoveryMode: governanceOperation(op)?'governance':'accountId' in op ? 'disaster' : op.recoveryMode, phase: op.phase, runtimeId: op.runtimeId, pointId: op.pointId,
        targetNodeId: op.targetNode, targetEpoch: op.newEpoch, reviewRevision: review?.id ?? null,
        suspendedEnvironmentKeys: op.suspendedEnvironmentKeys,
        preparationStatus: request?.status ?? 'idle', errorCode: request?.errorCode ?? null,
        status: enabled ? 'new-conversations-enabled' : review ? 'review-required' : 'unprepared',
        oldSessionCount: review?.oldSessionCount ?? null, tasksSuspended: true, sessionsReadOnly: true,
        items: review?.items ?? [], blockers: request?.status === 'failed' ? [request.errorCode ?? 'peer-backup/execution-preparation-failed'] : review?.blockers ?? [] }
    }, op)
  }

  /** List only current published recoveries physically owned by this entry, without reading business titles.
   * @param actor - authenticated administrator. @param after - last opaque operation ID from the preceding page.
   * @param inclusive - include the same ID when merging another scope after the cursor.
   * @returns at most fifty local project identities and a continuation when more remain.
   */
  async listLocal(actor: number, after?: string, inclusive = false) {
    if(this.options.governance)deny('governance-use-review-directory')
    if (after !== undefined) z.uuid().parse(after)
    return this.admin(actor, async tx => {
      if (this.options.personal) {
        const rows = (await tx.query<{id:string;userId:number;runtimeId:string;pointId:string}>(`SELECT r.id,u.public_id::float8 "userId",
          r.runtime_id "runtimeId",r.point_id "pointId" FROM harness.personal_recovery_operations r
          JOIN harness.users u ON u.id=r.user_id AND u.organization_id=r.organization_id
          JOIN harness.personal_recovery_execution_holds h ON h.operation_id=r.id
          JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
          JOIN harness.personal_directory_placement p ON p.organization_id=r.organization_id AND p.runtime_id=r.runtime_id
          WHERE r.organization_id=$1 AND r.target_node_id=$2 AND r.phase='published' AND r.target_activated_at IS NOT NULL
            AND i.assigned_node_id=$2 AND i.user_id=r.user_id AND p.node_id=$2 AND p.owner_id=r.user_id
            AND ($3::uuid IS NULL OR r.id>$3 OR ($4 AND r.id=$3)) ORDER BY r.id LIMIT 51`, [this.context.organizationId,this.context.nodeId,after??null,inclusive])).rows
        const items=rows.slice(0,50)
        return {items,...(rows.length>50?{nextCursor:items.at(-1)!.id}:{})}
      }
      const rows = (await tx.query<{id: string; projectId: number; runtimeId: string; pointId: string}>(`SELECT r.id,
        p.public_id::float8 "projectId",r.runtime_id "runtimeId",r.point_id "pointId"
        FROM ${this.table('operations')} r JOIN ${this.table('execution_holds')} h ON h.operation_id=r.id
        JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id
        JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
        JOIN harness.project_content_placement b ON b.organization_id=r.organization_id AND b.project_id=r.project_id
        WHERE r.organization_id=$1 AND r.target_node_id=$2 AND r.phase='published'
          AND r.target_activated_at IS NOT NULL AND p.status='active' AND i.assigned_node_id=$2
          AND (b.runtime_id,b.node_id,b.volume_id,b.writer_epoch)=(r.runtime_id,r.target_node_id,r.target_volume_id,r.target_epoch)
          AND ($3::uuid IS NULL OR r.id>$3 OR ($4 AND r.id=$3)) ORDER BY r.id LIMIT 51`, [this.context.organizationId, this.context.nodeId, after ?? null, inclusive])).rows
      const items = rows.slice(0, 50)
      return {items, ...(rows.length > 50 ? {nextCursor: items.at(-1)!.id} : {})}
    })
  }

  /** Queue target-owned inspection; neither a browser nor the primary supplies profile contents.
   * @param actor - authenticated administrator. @param id - recovery operation. @param input - exact confirmation.
   */
  async prepare(actor: number, id: string, input: unknown): Promise<void> {
    if (confirmation.parse(input).confirm !== id) deny('execution-review-changed')
    const op = await this.recovery.get(id)
    await this.admin(actor, async tx => {
      await this.lockPublished(tx, op, true)
      const previous = await this.request(tx, id)
      if (previous?.status === 'queued') return
      await tx.query(`INSERT INTO ${this.table('execution_requests')}(operation_id,organization_id,request_id,requested_by,status)
        SELECT $1,$2,$3,id,'queued' FROM harness.users WHERE organization_id=$2 AND public_id=$4
        ON CONFLICT(operation_id) DO UPDATE SET request_id=EXCLUDED.request_id,requested_by=EXCLUDED.requested_by,
          requested_at=clock_timestamp(),status='queued',review_id=NULL,error_code=NULL`, [id, this.context.organizationId, randomUUID(), actor])
      await this.audit(tx, actor, 'prepare', id)
    }, op)
  }

  /** Permit only the reviewed replacement's new conversations; historic execution holds remain immutable.
   * @param actor - authenticated administrator. @param id - recovery operation. @param input - exact current review and mode.
   */
  async enable(actor: number, id: string, input: unknown): Promise<void> {
    const body = reviewConfirmation.parse(input)
    if (body.confirm !== id) deny('execution-review-changed')
    const op = await this.recovery.get(id)
    await this.admin(actor, async tx => {
      await this.lockPublished(tx, op, true)
      const request = await this.request(tx, id)
      if (request?.status !== 'ready' || request.reviewId !== body.reviewRevision) deny('execution-review-changed')
      const review = await this.review(tx, body.reviewRevision)
      if (!review || review.blockers.length) deny('execution-review-required')
      const approved = await tx.query(`INSERT INTO ${this.table('execution_approvals')}(review_id,organization_id,approved_by,mode)
        SELECT $1,$2,id,$3 FROM harness.users WHERE organization_id=$2 AND public_id=$4 ON CONFLICT(review_id) DO NOTHING`,
      [body.reviewRevision, this.context.organizationId, body.mode, actor])
      if (approved.rowCount) await this.audit(tx, actor, 'enable-new-conversations', id)
    }, op)
  }

  /** Record one eligible artifact/configuration approval and queue a new target review while stopped.
   * @param actor - authenticated administrator. @param id - recovery operation. @param itemId - server-issued review item.
   * @param input - exact review, item digest and external review reference.
   */
  async approveItem(actor: number, id: string, itemId: string, input: unknown): Promise<void> {
    const body = itemConfirmation.parse(input)
    if (body.confirm !== id) deny('execution-review-changed')
    const op = await this.recovery.get(id)
    await this.admin(actor, async tx => {
      await this.lockPublished(tx, op, true)
      const request = await this.request(tx, id)
      const review = request?.reviewId ? await this.review(tx, request.reviewId) : undefined
      if (request?.status !== 'ready' || review?.id !== body.reviewRevision) deny('execution-review-changed')
      const item = review.items.find(value => value.id === itemId && value.itemDigest === body.itemDigest)
      if (item?.status !== 'eligible') deny('execution-item-unsupported')
      await tx.query(`INSERT INTO ${this.table('execution_item_approvals')}(review_id,item_digest,organization_id,approved_by,evidence_reference)
        SELECT $1,$2,$3,id,$4 FROM harness.users WHERE organization_id=$3 AND public_id=$5 ON CONFLICT(review_id,item_digest) DO NOTHING`,
      [review.id, item.itemDigest, this.context.organizationId, body.evidenceReference, actor])
      await tx.query(`UPDATE ${this.table('execution_requests')} SET request_id=$3,requested_at=clock_timestamp(),status='queued',error_code=NULL
        WHERE organization_id=$1 AND operation_id=$2`, [this.context.organizationId, id, randomUUID()])
      await this.audit(tx, actor, 'approve-item', id)
    }, op)
  }

  private config(): GatewayConfig {
    if (!this.options.config) throw new PeerBackupError(503, 'peer-backup/execution-not-provisioned')
    return this.options.config
  }

  private directory(op: ExecutionOperation): string {
    return join(this.config().stateRoot, 'recovery-execution', op.id)
  }

  private async privateText(file: string): Promise<string> {
    return readRecoveryExecutionPolicy(file, this.options.maxBytes ?? 64 << 20)
  }

  private async inspect(op: ExecutionOperation, approvedItems: readonly string[]): Promise<CompositionInspection> {
    const cfg = this.config(), anchor = join(cfg.dshRepoRoot, 'apps', 'cli', 'package.json')
    const module = createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot')
    const boot = await import(pathToFileURL(module).href) as RecoveryInspector
    if (typeof boot.inspectRecoveryProfile !== 'function') throw new PeerBackupError(503, 'peer-backup/execution-protocol-upgrade-required')
    let home: string, cwd: string, admin = false
    if(governanceOperation(op)){
      if(!this.options.governance)deny('execution-not-provisioned')
      const paths=await this.options.governance.paths(op);home=paths.home;cwd=paths.cwd;admin=paths.admin
    }else if ('accountId' in op) {
      if (!this.options.personal) deny('execution-not-provisioned')
      const paths = await this.options.personal.paths(op)
      home = paths.home; cwd = paths.cwd; admin = paths.admin
    } else {
      home = join(cfg.projectRuntimesRoot, String(op.publicId), 'dsh')
      if (!this.options.volume) throw new PeerBackupError(503, 'peer-backup/execution-not-provisioned')
      const space = await this.options.volume.readVolume(async tx => (await tx.query<{root_path: string}>(`SELECT root_path FROM node_content.spaces
        WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND node_id=$4 AND volume_id=$5 AND writer_epoch=$6`,
      [op.organizationId, op.projectId, op.runtimeId, op.targetNode, op.targetVolume, op.newEpoch])).rows[0])
      if (!space) deny('execution-review-changed')
      cwd = space.root_path
    }
    return boot.inspectRecoveryProfile({ home, profileDir: join(home, 'profiles', 'web'), cwd, installAnchor: anchor,
      trustedPatchFiles: ['base','web-app'].map(bundle => join(cfg.dshRepoRoot, 'packages', 'bundle', bundle, 'cordis.patch.yml')),
      trustedPackageDirectories: [cfg.modelGovernancePackage, ...(cfg.guardPatch ? [dirname(cfg.guardPatch)] : [])],
      presetFiles: ['standard','minimal','ptc','cordis'].map(name => join(cfg.dshRepoRoot, 'apps','cli','config','agent-presets',name,'agent.cordis.yml')),
      trustedPatchText: policyPatchText(cfg, { kind: operationKind(op), admin, steward: false }), approvedItems })
  }

  private async oldSessions(tx: Pick<PoolClient, 'query'>, op: ExecutionOperation): Promise<string[]> {
    const first = (await tx.query<{id: string; policyDigest: string}>(`SELECT id,policy_digest "policyDigest"
      FROM ${this.table('execution_reviews')} WHERE organization_id=$1 AND operation_id=$2 ORDER BY created_at,id LIMIT 1`,
    [this.context.organizationId, op.id])).rows[0]
    if (first) {
      const text = await this.privateText(join(this.directory(op), first.id + '.json'))
      if (digest(text) !== first.policyDigest) deny('execution-policy-missing')
      return (JSON.parse(text) as RecoveryPolicy).oldSessionIds
    }
    if(governanceOperation(op)){
      if(!this.options.governance)deny('execution-not-provisioned')
      return this.options.governance.oldSessions(op)
    }
    if ('accountId' in op) {
      if (!this.options.personal) deny('execution-not-provisioned')
      return this.options.personal.oldSessions(op)
    }
    if (op.executionTransfer) return transferredRecoverySessions(op,
      join(this.config().projectRuntimesRoot,String(op.publicId),'dsh'),
      {maxBytes:this.options.maxBytes ?? 64 << 20,maxRows:this.options.maxRows ?? 100000})
    const volume = this.options.volume
    if (!volume) throw new PeerBackupError(503, 'peer-backup/execution-not-provisioned')
    return volume.readVolume(async local => {
      if (!(await local.query(`SELECT FROM node_content.spaces WHERE organization_id=$1 AND runtime_id=$2
        AND project_id=$3 AND node_id=$4 AND volume_id=$5 AND writer_epoch=$6`,
      [op.organizationId, op.runtimeId, op.projectId, op.targetNode, op.targetVolume, op.newEpoch])).rowCount) deny('execution-review-changed')
      const rows = await local.query<{id: string}>(`SELECT id FROM (
        SELECT id FROM node_content.conversation_sessions WHERE organization_id=$1 AND runtime_id=$2
        UNION SELECT session_id FROM node_content.execution_sessions WHERE organization_id=$1 AND runtime_id=$2
        UNION SELECT session_id FROM node_content.conversation_draft_reservations WHERE organization_id=$1 AND runtime_id=$2
        UNION SELECT root_session_id FROM node_content.conversation_archive_records WHERE organization_id=$1 AND runtime_id=$2
        ) old ORDER BY id COLLATE "C" LIMIT $3`, [op.organizationId, op.runtimeId, (this.options.maxRows ?? 100000) + 1])
      if (rows.rows.length > (this.options.maxRows ?? 100000)) throw new PeerBackupError(507, 'peer-backup/export-budget')
      return rows.rows.map(row => row.id)
    })
  }

  /** Prepare at most one queued review on its assigned data owner; no Runtime is started or stopped.
   * @param signal - node service lifetime; cancellation leaves the queued request retryable.
   */
  async prepareNext(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (!this.options.config || !this.options.governance && !this.options.personal && !this.options.volume || !this.options.prepareProfile) return
    const next = (await this.context.pool.query<{id: string; requestId: string}>(`SELECT r.id,q.request_id "requestId"
      FROM ${this.table('execution_requests')} q JOIN ${this.table('operations')} r ON r.id=q.operation_id
      WHERE q.organization_id=$1 AND r.${this.options.governance?'node_id':'target_node_id'}=$2 AND q.status='queued' ORDER BY q.requested_at LIMIT 1`,
    [this.context.organizationId, this.context.nodeId])).rows[0]
    if (!next) return
    try {
      const op = await this.recovery.get(next.id)
      // Every Gateway preparing this physical Runtime shares the lock beside its home, independently of its pool size.
      const gate = new PeerProjectFileGate(operationKind(op)==='user' ? this.options.config.usersRoot : this.options.config.projectRuntimesRoot, 'peer-project-recovery-work')
      await gate.exclusive(operationPublicId(op), async () => {
        const approvals = await transaction(this.context.pool, async tx => {
          await this.lockPublished(tx, op, true)
          await this.nodeReady(tx, op)
          const request = await this.request(tx, op.id)
          if (request?.requestId !== next.requestId || request.status !== 'queued') return undefined
          return (await tx.query<{itemDigest: string}>(`SELECT DISTINCT a.item_digest "itemDigest"
            FROM ${this.table('execution_item_approvals')} a JOIN ${this.table('execution_reviews')} r ON r.id=a.review_id
            WHERE a.organization_id=$1 AND r.operation_id=$2 ORDER BY a.item_digest`, [this.context.organizationId, op.id])).rows
        }, signal)
        if (!approvals) return
        // The committed queued request rejects process admission while no governance connection is borrowed.
        signal.throwIfAborted()
        await this.options.prepareProfile!({ kind: operationKind(op), id: operationPublicId(op), runtimeId: op.runtimeId })
        const approvedItems = approvals.map(row => row.itemDigest)
        const inspected = await this.inspect(op, approvedItems)
        const oldSessionIds = await this.oldSessions(this.context.pool, op), reviewRevision = randomUUID()
        const policy: RecoveryPolicy = { version: 1, mode: 'new-conversations-only', operationId: op.id, pointId: op.pointId,
          runtimeId: op.runtimeId, nodeId: op.targetNode, writerEpoch: op.newEpoch, reviewRevision, oldSessionIds, approvedItems,
          compositionDigest: inspected.compositionDigest, composition: inspected.composition }
        const text = JSON.stringify(policy) + '\n'
        if (Buffer.byteLength(text) > (this.options.maxBytes ?? 64 << 20)) throw new PeerBackupError(507, 'peer-backup/export-budget')
        await peerPrivateDirectory(this.directory(op))
        const file = join(this.directory(op), reviewRevision + '.json')
        await writeFile(file, text, { mode: 0o600, flag: 'wx', flush: true })
        if (await this.privateText(file) !== text) deny('execution-policy-missing')
        signal.throwIfAborted()
        await transaction(this.context.pool, async tx => {
          await this.lockPublished(tx, op, true)
          await this.nodeReady(tx, op)
          const request = await this.request(tx, op.id)
          if (request?.requestId !== next.requestId || request.status !== 'queued') deny('execution-review-changed')
          await tx.query(`INSERT INTO ${this.table('execution_reviews')}(id,operation_id,organization_id,runtime_id,target_node_id,
            target_epoch,point_id,policy_digest,composition_digest,old_session_count,items,blockers)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [reviewRevision, op.id, op.organizationId, op.runtimeId,
          op.targetNode, op.newEpoch, op.pointId, digest(text), inspected.compositionDigest, oldSessionIds.length, JSON.stringify(inspected.items), JSON.stringify(inspected.blockers)])
          await tx.query(`UPDATE ${this.table('execution_requests')} SET status='ready',review_id=$3,error_code=NULL
            WHERE organization_id=$1 AND operation_id=$2 AND request_id=$4`, [op.organizationId, op.id, reviewRevision, next.requestId])
        }, signal)
      })
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof PeerBackupError && error.code === 'peer-backup/project-files-busy') return
      const code = error instanceof PeerBackupError ? error.code : 'peer-backup/execution-preparation-failed'
      await this.context.pool.query(`UPDATE ${this.table('execution_requests')} SET status='failed',error_code=$4
        WHERE organization_id=$1 AND operation_id=$2 AND request_id=$3 AND status='queued'`,
      [this.context.organizationId, next.id, next.requestId, code])
      if (!(error instanceof PeerBackupError)) console.error('[gateway] recovery execution preparation failed:', error)
    }
  }

  private async permitted(runtimeId: string): Promise<{op: ExecutionOperation; review: ReviewRow; policy: RecoveryPolicy; policyFile: string} | undefined> {
    const governanceHold=this.options.governance?await this.options.governance.selectHold(runtimeId):undefined
    const hold = this.options.governance?(governanceHold?{id:governanceHold}:undefined):(await this.context.pool.query<{id: string}>(`SELECT h.operation_id id FROM ${this.table('execution_holds')} h
      JOIN ${this.table('operations')} r ON r.id=h.operation_id
      WHERE h.organization_id=$1 AND h.runtime_id=$2 ORDER BY r.target_epoch DESC,r.created_at DESC LIMIT 1`, [this.context.organizationId, runtimeId])).rows[0]
    if (!hold) return undefined
    const op = await this.recovery.get(hold.id)
    if (op.targetNode !== this.context.nodeId || op.runtimeId !== runtimeId || (governanceOperation(op)?op.phase!=='released':op.phase!=='published')) deny('execution-review-required')
    const request = await this.request(this.context.pool, op.id)
    const review = request?.status === 'ready' && request.reviewId ? await this.review(this.context.pool, request.reviewId) : undefined
    if (!review || review.blockers.length || !(await this.context.pool.query(`SELECT FROM ${this.table('execution_approvals')}
      WHERE organization_id=$1 AND review_id=$2 AND harness.recovery_execution_allowed($1,$3,$4)`,
    [this.context.organizationId, review.id, runtimeId, this.context.nodeId])).rowCount) deny('execution-review-required')
    const policyFile = join(this.directory(op), review.id + '.json')
    const text = await this.privateText(policyFile)
    if (digest(text) !== review.policyDigest) deny('execution-policy-missing')
    const policy = JSON.parse(text) as RecoveryPolicy
    if (policy.operationId !== op.id || policy.runtimeId !== runtimeId || policy.nodeId !== op.targetNode
      || policy.writerEpoch !== op.newEpoch || policy.pointId !== op.pointId || policy.reviewRevision !== review.id) deny('execution-review-changed')
    const current = await this.inspect(op, policy.approvedItems)
    if (current.compositionDigest !== review.compositionDigest || current.blockers.length) deny('execution-profile-changed')
    return { op, review, policy, policyFile }
  }

  /** Bind a managed process launch to its exact immutable node-local recovery policy.
   * @param runtime - exact assigned Runtime after ordinary managed-profile preparation.
   * @returns private policy handoff, or undefined for an ordinary Runtime.
   */
  async beforeStart(runtime: RuntimeLaunchContext): Promise<{policyFile: string; policySha256: string} | undefined> {
    if (!runtime.target.runtimeId || !this.options.governance && runtime.kind !== (this.options.personal ? 'user' : 'project')) return undefined
    const allowed = await this.permitted(runtime.target.runtimeId)
    if (!allowed) return undefined
    return { policyFile: allowed.policyFile, policySha256: allowed.review.policyDigest }
  }

  /** Refuse composition reload when recovery approval, placement or reviewed artifact bytes changed.
   * @param subject - currently authenticated Runtime generation and node-content placement.
   */
  async verifySubject(subject: RuntimeCredentialSubject): Promise<void> {
    if (subject.organizationId !== this.context.organizationId) deny('execution-review-changed')
    if (!subject.target.runtimeId || !this.options.governance && subject.target.kind !== (this.options.personal ? 'user' : 'project')) return
    const allowed = await this.permitted(subject.target.runtimeId)
    if(allowed&&governanceOperation(allowed.op)){
      if(subject.target.kind!==allowed.op.ownerKind||BigInt(subject.generation)<BigInt(allowed.op.sourceGeneration))deny('execution-review-changed')
      if(allowed.op.ownerKind==='user'){
        if(subject.userInternalId!==allowed.op.ownerId)deny('execution-review-changed')
      }else if(!subject.contentBinding||subject.contentBinding.nodeId!==allowed.op.targetNode||subject.contentBinding.volumeId!==allowed.op.targetVolume||subject.contentBinding.writerEpoch!==allowed.op.newEpoch)deny('execution-review-changed')
      return
    }
    if (allowed && 'accountId' in allowed.op) {
      if (subject.userInternalId !== allowed.op.accountId || BigInt(subject.generation) < BigInt(allowed.op.newEpoch)) deny('execution-review-changed')
      return
    }
    if (allowed && (!subject.contentBinding || subject.contentBinding.nodeId !== allowed.op.targetNode
      || subject.contentBinding.writerEpoch !== allowed.op.newEpoch || subject.contentBinding.volumeId !== allowed.op.targetVolume)) deny('execution-review-changed')
  }
}
