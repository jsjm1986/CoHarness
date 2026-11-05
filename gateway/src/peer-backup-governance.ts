/** Organization controls contain opaque scope, node, policy and operation identities plus bounded status. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { transaction, type Queryable } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { PeerBackupError, peerSecretMatches, type PeerPoint, type PeerRepositoryGrant } from './peer-backup-repository.ts'
import type { PeerBackupBinding, PeerBackupProgress } from './peer-backup-restic.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const policyInput = z
  .object({
    id: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    scopeKind: z.enum(['project', 'personal', 'governance']),
    scopeId: z.uuid(),
    sourceNodeId: z.uuid(),
    targetNodeId: z.uuid(),
    tier: z.enum(['important', 'ordinary']),
    enabled: z.boolean(),
    quotaBytes: z
      .number()
      .int()
      .min(1 << 20)
      .max(Number.MAX_SAFE_INTEGER),
    appendFingerprint: hash,
    recoveryFingerprint: hash,
  })
  .strict()
export type PeerBackupPolicyInput = z.infer<typeof policyInput>
export interface PeerBackupPolicy extends PeerBackupBinding {
  scopeKind: 'project' | 'personal' | 'governance'
  tier: 'important' | 'ordinary'
  enabled: boolean
  quotaBytes: number
}
export interface PeerBackupJob {
  id: string
  kind: 'capture' | 'drill'
  pointId: string | null
  claim: string
  policy: PeerBackupPolicy
}

const columns = `p.id "policyId", p.organization_id "organizationId", p.scope_kind "scopeKind", p.scope_id "scopeId",
  p.source_node_id "sourceNodeId", p.target_node_id "targetNodeId", p.revision, p.tier, p.enabled, p.quota_bytes::float8 "quotaBytes"`
const typeProjection = `CASE WHEN p.tier='important' THEN interval '15 minutes' ELSE interval '1 hour' END`
const safeError = /^peer-backup\/[a-z0-9-]{1,70}$/u
export const PEER_RPO_MS = { important: 900000, ordinary: 3600000 } as const

/** An active target, including the primary itself, must retain current organization membership. */
export async function checkPeerBackupNode(db: Queryable, org: string, node: string, requireLive: boolean): Promise<void> {
  const result = await db.query(
    `SELECT 1 FROM harness.organizations o JOIN harness.deployment_topology t ON t.organization_id=o.id
    JOIN harness.compute_nodes n ON n.organization_id=o.id AND n.id=$2 JOIN harness.cluster_control c ON c.organization_id=o.id
    WHERE o.id=$1 AND o.status='active' AND t.enabled AND n.status='active' AND c.mode='serving'
      AND (t.primary_node_id=n.id OR EXISTS(SELECT 1 FROM harness.node_agents a WHERE a.organization_id=o.id AND a.node_id=n.id
        AND a.attachment_state='managed' AND a.revoked_at IS NULL AND a.credential_hash IS NOT NULL
        AND (NOT $3::boolean OR (a.connection_id IS NOT NULL AND a.lease_expires_at>clock_timestamp()))))`,
    [org, node, requireLive],
  )
  if (!result.rowCount) throw new PeerBackupError(403, 'peer-backup/node-not-admitted')
}

async function checkScope(
  db: Queryable,
  p: Pick<PeerBackupPolicy, 'organizationId' | 'sourceNodeId' | 'scopeKind' | 'scopeId'>,
): Promise<void> {
  const params = [p.organizationId, p.sourceNodeId, p.scopeId]
  const result =
    p.scopeKind === 'governance'
      ? await db.query(
          'SELECT 1 FROM harness.deployment_topology WHERE organization_id=$1 AND primary_node_id=$2 AND organization_id=$3 AND enabled',
          params,
        )
      : await db.query(
          `SELECT 1 FROM harness.runtime_environments WHERE organization_id=$1 AND node_id=$2 AND retired_at IS NULL
      AND ${p.scopeKind === 'personal' ? "id=$3 AND owner_kind='user'" : "owner_id=$3 AND owner_kind='project'"}`,
          params,
        )
  if (!result.rowCount) throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
}

/** All administrator mutations recheck the current account and audit the opaque operation in the same transaction. */
export class PeerBackupGovernance {
  constructor(
    readonly context: PostgresRuntimeContext,
    readonly leaseMs = 60000,
  ) {}

  private async admin<T>(actor: number, work: (db: PoolClient) => Promise<T>): Promise<T> {
    return transaction(this.context.pool, async (db) => {
      await lockAdministrator(db, this.context, actor)
      const entry = await db.query(
        `SELECT 1 FROM harness.deployment_topology WHERE organization_id=$1 AND primary_node_id=$2 AND enabled FOR SHARE`,
        [this.context.organizationId, this.context.nodeId],
      )
      if (!entry.rowCount) throw new PeerBackupError(403, 'peer-backup/primary-required')
      await db.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1) ON CONFLICT DO NOTHING', [
        this.context.organizationId,
      ])
      return work(db)
    })
  }

  /** Store the approved pair and fingerprints. No bearer or recovery password enters the organization database. */
  async configure(actor: number, raw: unknown): Promise<PeerBackupPolicy> {
    const input = policyInput.parse(raw)
    if (input.sourceNodeId === input.targetNodeId || input.appendFingerprint === input.recoveryFingerprint)
      throw new PeerBackupError(400, 'peer-backup/invalid-pair')
    return this.admin(actor, async (db) => {
      const existing = await db.query<PeerBackupPolicy>(
        `SELECT ${columns} FROM harness.peer_backup_policies p WHERE p.id=$1 AND p.organization_id=$2 FOR UPDATE`,
        [input.id, this.context.organizationId],
      )
      const old = existing.rows[0]
      if ((old?.revision ?? 0) !== input.expectedRevision) throw new PeerBackupError(409, 'peer-backup/revision-conflict')
      if (
        old &&
        (old.sourceNodeId !== input.sourceNodeId ||
          old.targetNodeId !== input.targetNodeId ||
          old.scopeId !== input.scopeId ||
          old.scopeKind !== input.scopeKind)
      ) {
        throw new PeerBackupError(409, 'peer-backup/new-policy-required')
      }
      if (input.enabled) {
        await checkPeerBackupNode(db, this.context.organizationId, input.sourceNodeId, false)
        await checkPeerBackupNode(db, this.context.organizationId, input.targetNodeId, false)
        const stagedReplacement = old && input.scopeKind === 'project' && (await db.query(`SELECT FROM harness.project_recovery_operations r
          JOIN harness.project_content_placement b ON b.organization_id=r.organization_id AND b.project_id=r.project_id AND b.runtime_id=r.runtime_id
          WHERE r.organization_id=$1 AND r.policy_id=$2 AND r.project_id=$3 AND r.source_node_id=$4 AND r.target_node_id=$5
            AND r.phase='published' AND r.target_activated_at IS NULL AND b.node_id=r.target_node_id AND b.volume_id=r.target_volume_id
            AND b.writer_epoch=r.target_epoch FOR SHARE OF r,b`,[this.context.organizationId,old.policyId,old.scopeId,old.sourceNodeId,old.targetNodeId])).rowCount
        if (!stagedReplacement) await checkScope(db, { ...input, organizationId: this.context.organizationId })
      }
      const result = await db.query<PeerBackupPolicy>(
        `INSERT INTO harness.peer_backup_policies AS p
        (id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,enabled,revision,quota_bytes,append_hash,recovery_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11)
        ON CONFLICT(id) DO UPDATE SET tier=EXCLUDED.tier,enabled=EXCLUDED.enabled,revision=p.revision+1,quota_bytes=EXCLUDED.quota_bytes,
          append_hash=EXCLUDED.append_hash,recovery_hash=EXCLUDED.recovery_hash,updated_at=now(),next_capture_at=now()
          WHERE p.organization_id=EXCLUDED.organization_id AND p.revision=$12
        RETURNING ${columns}`,
        [
          input.id,
          this.context.organizationId,
          input.scopeKind,
          input.scopeId,
          input.sourceNodeId,
          input.targetNodeId,
          input.tier,
          input.enabled,
          input.quotaBytes,
          input.appendFingerprint,
          input.recoveryFingerprint,
          input.expectedRevision,
        ],
      )
      const saved = result.rows[0]
      if (!saved) throw new PeerBackupError(409, 'peer-backup/revision-conflict')
      await db.query(
        `UPDATE harness.peer_backup_work SET status='failed',error_code='peer-backup/policy-changed',finished_at=now()
        WHERE policy_id=$1 AND status IN ('running','queued')`,
        [input.id],
      )
      await this.audit(db, actor, 'configure', input.id)
      return saved
    })
  }

  private async audit(db: Queryable, actor: number, action: string, resource: string): Promise<void> {
    await db.query(
      `INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,detail)
      SELECT $1,u.id,$3,'peer-backup',$4::text,jsonb_build_object('detail',jsonb_build_object('id',$4::text)) FROM harness.users u WHERE u.organization_id=$1 AND u.public_id=$2`,
      [this.context.organizationId, actor, 'admin.peer-backups.' + action, resource],
    )
  }

  /** List the latest durable recovery point, worker progress and independent recovery drill per policy. */
  async list(actor: number, after = '', limit = 50): Promise<unknown[]> {
    if (after) z.uuid().parse(after)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PeerBackupError(400, 'peer-backup/invalid-page')
    return this.admin(
      actor,
      async (db) =>
        (
          await db.query(
            `SELECT ${columns},p.append_hash "appendFingerprint",p.recovery_hash "recoveryFingerprint",
      CASE WHEN q.protected_through IS NULL THEN 'unprotected' WHEN q.gap_count>0 THEN 'partial'
        WHEN q.protected_through<clock_timestamp()-(${typeProjection}) THEN 'overdue' ELSE 'current' END coverage,
      q.id "pointId",q.protected_through "protectedThrough",q.covered_count "coveredCount",q.gap_count "gapCount",q.gap_types "gapTypes",q.repository_bytes::float8 "repositoryBytes",q.available_bytes::float8 "availableBytes",
      j.status "jobStatus",j.phase,j.pending_bytes::float8 "pendingBytes",j.error_code "errorCode",
      d.status "drillStatus",d.finished_at "lastDrillAt",d.point_id "drilledPointId",d.recovery_ms::float8 "recoveryMs"
      FROM harness.peer_backup_policies p LEFT JOIN LATERAL (SELECT * FROM harness.peer_backup_points p2
        WHERE p2.policy_id=p.id ORDER BY protected_through DESC LIMIT 1) q ON true
      LEFT JOIN LATERAL (SELECT * FROM harness.peer_backup_work j2 WHERE j2.policy_id=p.id AND kind='capture' ORDER BY created_at DESC LIMIT 1) j ON true
      LEFT JOIN LATERAL (SELECT * FROM harness.peer_backup_work d2 WHERE d2.policy_id=p.id AND kind='drill' ORDER BY created_at DESC LIMIT 1) d ON true
      WHERE p.organization_id=$1 AND ($2::uuid IS NULL OR p.id>$2::uuid) ORDER BY p.id LIMIT $3`,
            [this.context.organizationId, after || null, limit],
          )
        ).rows,
    )
  }

  /** Recovery point history is paged independently of worker liveness. */
  async points(actor: number, policyId: string): Promise<unknown[]> {
    z.uuid().parse(policyId)
    return this.admin(
      actor,
      async (db) =>
        (
          await db.query(
            `SELECT id,writer_epoch::text "writerEpoch",watermark::text,
      protected_through "protectedThrough",confirmed_at "confirmedAt",covered_count "coveredCount",gap_count "gapCount",gap_types "gapTypes"
      FROM harness.peer_backup_points WHERE organization_id=$1 AND policy_id=$2 ORDER BY protected_through DESC,id DESC LIMIT 100`,
            [this.context.organizationId, policyId],
          )
        ).rows,
    )
  }

  /** Select destination-independent scope coordinates from the account's existing administration directory. */
  async choices(
    actor: number,
    source: string,
    kind: 'project' | 'personal' | 'governance',
    after?: string,
  ): Promise<unknown[]> {
    z.uuid().parse(source)
    if (after) z.uuid().parse(after)
    return this.admin(actor, async (db) => {
      await checkPeerBackupNode(db, this.context.organizationId, source, false)
      if (kind === 'governance')
        return (
          await db.query(
            `SELECT organization_id AS id,0 AS "publicId" FROM harness.deployment_topology
        WHERE organization_id=$1 AND primary_node_id=$2 AND enabled`,
            [this.context.organizationId, source],
          )
        ).rows
      const project = kind === 'project'
      return (
        await db.query(
          `SELECT ${project ? 'r.owner_id' : 'r.id'} AS id,o.public_id::text "publicId"
        FROM harness.runtime_environments r JOIN harness.${project ? 'projects' : 'users'} o ON r.owner_id=o.id AND r.organization_id=o.organization_id
        WHERE r.organization_id=$1 AND r.node_id=$2 AND r.owner_kind=$3 AND r.retired_at IS NULL
          AND ($4::uuid IS NULL OR ${project ? 'r.owner_id' : 'r.id'}>$4::uuid)
        ORDER BY ${project ? 'r.owner_id' : 'r.id'} LIMIT 100`,
          [this.context.organizationId, source, project ? 'project' : 'user', after ?? null],
        )
      ).rows
    })
  }

  /** Independently confirmed exact-point rehearsal is required before an owner-fenced promotion can even be considered. */
  async preflight(
    actor: number,
    policyId: string,
    pointId: string,
    destination: string,
  ): Promise<{ readyForFencing: boolean; blockers: string[] }> {
    z.uuid().parse(policyId)
    z.uuid().parse(pointId)
    z.uuid().parse(destination)
    return this.admin(actor, async (db) => {
      const row = (
        await db.query<{ gap_count: number; source: string; checked: boolean;scope_kind:string }>(
          `SELECT q.gap_count,p.source_node_id source,p.scope_kind,
        EXISTS(SELECT FROM harness.peer_backup_work d WHERE d.kind='drill' AND d.status='confirmed' AND d.policy_id=p.id
          AND d.point_id=q.id AND d.node_id=$4 AND d.revision=p.revision) checked
        FROM harness.peer_backup_policies p JOIN harness.peer_backup_points q ON q.policy_id=p.id
        WHERE p.organization_id=$1 AND p.id=$2 AND q.id=$3`,
          [this.context.organizationId, policyId, pointId, destination],
        )
      ).rows[0]
      if (!row) throw new PeerBackupError(404, 'peer-backup/missing-point')
      const blockers = []
      if(row.scope_kind!=='project')blockers.push('peer-backup/isolated-recovery-only')
      if (row.gap_count) blockers.push('peer-backup/coverage-incomplete')
      if (destination === row.source || !row.checked) blockers.push('peer-backup/independent-drill-required')
      await checkPeerBackupNode(db, this.context.organizationId, destination, true)
      return { readyForFencing: !blockers.length, blockers: [...blockers, 'peer-backup/verified-writer-fence-required'] }
    })
  }

  /** Submit bounded background work. A drill runs on the selected recovery node even when the former source is gone. */
  async enqueue(
    actor: number,
    policyId: string,
    kind: 'capture' | 'drill',
    pointId?: string,
    recoveryNodeId?: string,
  ): Promise<string> {
    z.uuid().parse(policyId)
    if (kind === 'drill') {
      z.uuid().parse(pointId)
      z.uuid().parse(recoveryNodeId)
    }
    return this.admin(actor, async (db) => {
      const p = (
        await db.query<PeerBackupPolicy>(
          `SELECT ${columns} FROM harness.peer_backup_policies p WHERE p.id=$1 AND p.organization_id=$2 AND p.enabled FOR UPDATE`,
          [policyId, this.context.organizationId],
        )
      ).rows[0]
      if (!p) throw new PeerBackupError(404, 'peer-backup/missing-policy')
      if (kind === 'drill') {
        const known = await db.query('SELECT 1 FROM harness.peer_backup_points WHERE policy_id=$1 AND id=$2', [
          policyId,
          pointId,
        ])
        if (!known.rowCount || recoveryNodeId === p.sourceNodeId)
          throw new PeerBackupError(409, 'peer-backup/independent-drill-required')
        await checkPeerBackupNode(db, p.organizationId, recoveryNodeId!, false)
      }
      const pending = await db.query<{ id: string }>(
        `SELECT id FROM harness.peer_backup_work WHERE policy_id=$1 AND kind=$2
        AND status IN ('queued','running') AND point_id IS NOT DISTINCT FROM $3::uuid AND node_id=$4`,
        [policyId, kind, pointId ?? null, recoveryNodeId ?? p.sourceNodeId],
      )
      if (pending.rows[0]) return pending.rows[0].id
      const id = randomUUID()
      await db.query(
        `INSERT INTO harness.peer_backup_work(id,policy_id,organization_id,revision,kind,node_id,point_id,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'queued')`,
        [id, policyId, p.organizationId, p.revision, kind, recoveryNodeId ?? p.sourceNodeId, pointId ?? null],
      )
      await this.audit(db, actor, kind, id)
      return id
    })
  }

  /** Authenticate the dedicated recipient or escrow reader against the current exact policy. */
  async grant(id: string, user: string, token: string): Promise<PeerRepositoryGrant> {
    const fingerprint = createHash('sha256').update(token).digest('hex')
    const read = async (): Promise<PeerRepositoryGrant> => {
      const p = (
        await this.context.pool.query<PeerBackupPolicy & { appendHash: string; recoverHash: string }>(
          `SELECT ${columns},p.append_hash "appendHash",p.recovery_hash "recoverHash" FROM harness.peer_backup_policies p
         WHERE p.id=$1 AND p.organization_id=$2 AND p.enabled`,
          [id, this.context.organizationId],
        )
      ).rows[0]
      if (!p || user !== p.sourceNodeId) throw new PeerBackupError(403, 'peer-backup/pair-denied')
      const mode = peerSecretMatches(fingerprint, p.appendHash)
        ? 'append'
        : peerSecretMatches(fingerprint, p.recoverHash)
          ? 'recover'
          : null
      if (!mode) throw new PeerBackupError(403, 'peer-backup/pair-denied')
      await checkPeerBackupNode(this.context.pool, p.organizationId, p.targetNodeId, true)
      if (mode === 'append') {
        await checkPeerBackupNode(this.context.pool, p.organizationId, p.sourceNodeId, true)
        await checkScope(this.context.pool, p)
      }
      return {
        ...p,
        mode,
        revalidate: async () => {
          const current = await read()
          if (current.revision !== p.revision || current.mode !== mode)
            throw new PeerBackupError(409, 'peer-backup/policy-changed')
        },
      }
    }
    return read()
  }

  /** Create due jobs on the source node and fence one queued or abandoned attempt. */
  async claim(): Promise<PeerBackupJob | null> {
    return transaction(this.context.pool, async (db) => {
      await db.query(
        `INSERT INTO harness.peer_backup_work(id,policy_id,organization_id,revision,kind,node_id,status)
        SELECT gen_random_uuid(),p.id,p.organization_id,p.revision,'capture',p.source_node_id,'queued'
        FROM harness.peer_backup_policies p JOIN harness.cluster_control c ON c.organization_id=p.organization_id AND c.mode='serving'
        WHERE p.organization_id=$1 AND p.source_node_id=$2 AND p.enabled AND p.next_capture_at<=now()
        ON CONFLICT DO NOTHING`,
        [this.context.organizationId, this.context.nodeId],
      )
      const row = (
        await db.query<{ id: string; kind: 'capture' | 'drill'; pointId: string | null; policy: PeerBackupPolicy }>(
          `SELECT w.id,w.kind,w.point_id "pointId",
        (SELECT row_to_json(s) FROM (SELECT ${columns}) s) policy FROM harness.peer_backup_work w JOIN harness.peer_backup_policies p ON p.id=w.policy_id
        WHERE w.organization_id=$1 AND w.node_id=$2 AND p.enabled AND w.revision=p.revision
          AND EXISTS(SELECT FROM harness.cluster_control c WHERE c.organization_id=p.organization_id AND c.mode='serving')
          AND (w.status='queued' OR (w.status='running' AND w.lease_expires_at<clock_timestamp()))
        ORDER BY w.created_at,w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,
          [this.context.organizationId, this.context.nodeId],
        )
      ).rows[0]
      if (!row) return null
      const claim = randomUUID()
      await db.query(
        `UPDATE harness.peer_backup_work SET claim=$2,status='running',phase='preparing',lease_expires_at=clock_timestamp()+$3*interval '1 millisecond'
        WHERE id=$1`,
        [row.id, claim, this.leaseMs],
      )
      return { ...row, claim }
    })
  }

  /**
   * Keep one claimed operation admitted until its network or disk work settles. Lease loss cancels that work.
   * @param job - current attempt's claim and policy revision.
   * @param shutdown - owning worker's lifetime.
   * @param work - receives cancellation and a nonblocking progress reporter.
   * @returns the result of the claimed operation.
   */
  async withLease<T>(
    job: PeerBackupJob,
    shutdown: AbortSignal,
    work: (signal: AbortSignal, report: (progress: PeerBackupProgress) => void) => Promise<T>,
  ): Promise<T> {
    const revoked = new AbortController(),
      signal = AbortSignal.any([shutdown, revoked.signal])
    let progress: PeerBackupProgress = { phase: 'capturing', pendingBytes: null }
    let pending: Promise<void> | undefined
    const pulse = setInterval(
      () => {
        if (!pending)
          pending = this.heartbeat(job, progress)
            .catch(() => {
              revoked.abort()
            })
            .finally(() => {
              pending = undefined
            })
      },
      Math.max(1000, Math.floor(this.leaseMs / 3)),
    )
    pulse.unref()
    try {
      return await work(signal, (value) => {
        progress = value
      })
    } finally {
      clearInterval(pulse)
      await pending
    }
  }

  /** Progress renews one precise attempt and never acknowledges a restore point. */
  async heartbeat(job: PeerBackupJob, update: PeerBackupProgress): Promise<void> {
    const result = await this.context.pool.query(
      `UPDATE harness.peer_backup_work w SET phase=$3,pending_bytes=$4,
      lease_expires_at=clock_timestamp()+$5*interval '1 millisecond' FROM harness.peer_backup_policies p
      WHERE w.id=$1 AND w.claim=$2 AND w.status='running' AND w.policy_id=p.id AND p.enabled AND p.revision=w.revision AND w.lease_expires_at>clock_timestamp()
        AND EXISTS(SELECT FROM harness.cluster_control c WHERE c.organization_id=p.organization_id AND c.mode='serving')`,
      [job.id, job.claim, update.phase, update.pendingBytes, this.leaseMs],
    )
    if (!result.rowCount) throw new PeerBackupError(409, 'peer-backup/claim-lost')
  }

  /** Publish a result only for the still-owned attempt. An incomplete transfer never advances protectedThrough. */
  async finish(job: PeerBackupJob, result: { point?: PeerPoint; recoveryMs?: number; errorCode?: string }): Promise<void> {
    if (
      (result.errorCode && (result.point || result.recoveryMs !== undefined)) ||
      (job.kind === 'drill' &&
        !result.errorCode &&
        (!Number.isSafeInteger(result.recoveryMs) || Number(result.recoveryMs) < 0))
    ) {
      throw new PeerBackupError(409, 'peer-backup/invalid-receipt')
    }
    await transaction(this.context.pool, async (db) => {
      const owned = await db.query(
        `UPDATE harness.peer_backup_work w SET status=$3,finished_at=now(),error_code=$4,recovery_ms=$5,
        phase=$3,pending_bytes=CASE WHEN $4::text IS NULL THEN 0 ELSE pending_bytes END,lease_expires_at=NULL
        FROM harness.peer_backup_policies p WHERE w.id=$1 AND w.claim=$2 AND w.status='running' AND w.policy_id=p.id AND p.enabled
        AND p.revision=w.revision AND w.lease_expires_at>clock_timestamp()
        AND EXISTS(SELECT FROM harness.cluster_control c WHERE c.organization_id=p.organization_id AND c.mode='serving')`,
        [
          job.id,
          job.claim,
          result.errorCode ? 'failed' : 'confirmed',
          result.errorCode && safeError.test(result.errorCode)
            ? result.errorCode
            : result.errorCode
              ? 'peer-backup/failed'
              : null,
          result.recoveryMs ?? null,
        ],
      )
      if (!owned.rowCount) throw new PeerBackupError(409, 'peer-backup/claim-lost')
      if (job.kind === 'capture') {
        const p = result.point
        if (
          !result.errorCode &&
          (!p ||
            p.pointId !== job.id ||
            p.policyId !== job.policy.policyId ||
            p.revision !== job.policy.revision ||
            p.sourceNodeId !== job.policy.sourceNodeId ||
            p.targetNodeId !== job.policy.targetNodeId ||
            p.scopeId !== job.policy.scopeId ||
            p.organizationId !== job.policy.organizationId)
        )
          throw new PeerBackupError(409, 'peer-backup/point-mismatch')
        if (p && !result.errorCode)
          await db.query(
            `INSERT INTO harness.peer_backup_points(id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,
          manifest_digest,covered_count,gap_count,protected_through,gap_types,repository_bytes,available_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              p.pointId,
              p.organizationId,
              p.policyId,
              p.revision,
              p.writerEpoch,
              p.watermark,
              p.snapshotId,
              p.manifestDigest,
              p.coveredCount,
              p.gapCount,
              p.capturedAt,
              p.gapTypes ?? [],
              p.repositoryBytes ?? null,
              p.availableBytes ?? null,
            ],
          )
        await db.query(
          `UPDATE harness.peer_backup_policies SET next_capture_at=CASE WHEN $2::timestamptz IS NULL THEN now()+interval '1 minute'
          ELSE GREATEST(now(),$2::timestamptz+$3*interval '1 millisecond') END WHERE id=$1`,
          [job.policy.policyId, p?.capturedAt ?? null, PEER_RPO_MS[job.policy.tier] / 2],
        )
      }
    })
  }
}
