/** Administrator-registered OpenSSH targets and project sharing. */
import { z } from 'zod'
import { transaction } from './database.ts'
import type { PoolClient } from 'pg'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

/** Public target view for administrators; carries no secret material because targets reference OpenSSH aliases. */
export interface SshTargetView {
  publicId: number
  name: string
  host: string
  node: string
  helper: string
  helperHash: string
  workspace: string
  bootstrapPath: string | null
  bootstrapHash: string | null
  passwordRef: string | null
  requestTimeoutMs: number | null
  maxFrameBytes: number | null
  maxPending: number | null
  leaseMs: number | null
  enabled: boolean
  revision: string
  sharedProjects: number[]
}

/** Project-scoped target view for self-service sharing; carries no share state of other projects. */
export interface ProjectSshTargetView {
  publicId: number
  name: string
  host: string
  workspace: string
  enabled: boolean
  shared: boolean
}

/** Connection configuration released to one authorized managed runtime. */
export interface ResolvedSshTarget {
  host: string
  node: string
  helper: string
  helperHash: string
  workspace: string
  bootstrapPath?: string
  bootstrapHash?: string
  /** Credential reference resolved by the connecting runtime for OpenSSH askpass. */
  passwordRef?: string
  requestTimeoutMs?: number
  maxFrameBytes?: number
  maxPending?: number
  leaseMs?: number
}

/** A registration, share, or resolution request was invalid or addressed a missing row. */
export class SshTargetError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message) }
}

function isCodedError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
}

const HASH = /^[0-9a-f]{64}$/u
const REVISION = /^(0|[1-9][0-9]{0,18})$/u

// Field bounds mirror the dsh-ssh SshConnection Config schema; both sides must move together.
const fields = z.object({
  name: z.string().min(1).max(128),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/u).max(256),
  node: z.string().startsWith('/').max(1024),
  helper: z.string().startsWith('/').max(1024),
  helperHash: z.string().regex(HASH),
  workspace: z.string().startsWith('/').max(1024),
  bootstrapPath: z.string().startsWith('/').max(1024).nullish(),
  bootstrapHash: z.string().regex(HASH).nullish(),
  passwordRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).max(256).nullish(),
  requestTimeoutMs: z.number().int().min(1).max(2_147_483_647).nullish(),
  maxFrameBytes: z.number().int().positive().max(67_108_864).nullish(),
  maxPending: z.number().int().positive().max(128).nullish(),
  leaseMs: z.number().int().min(3_000).max(600_000).nullish(),
}).strict().refine(value => (value.bootstrapPath === undefined || value.bootstrapPath === null)
  === (value.bootstrapHash === undefined || value.bootstrapHash === null), { message: 'bootstrap path and hash must be supplied together' })

const identity = z.object({ targetId: z.number().int().positive(), revision: z.string().regex(REVISION) }).strict()
const shareInput = z.object({ targetId: z.number().int().positive(), projectId: z.number().int().positive() }).strict()

interface TargetRow {
  id: string
  public_id: string
  name: string
  host: string
  node: string
  helper: string
  helper_hash: string
  workspace: string
  bootstrap_path: string | null
  bootstrap_hash: string | null
  password_ref: string | null
  request_timeout_ms: number | null
  max_frame_bytes: number | null
  max_pending: number | null
  lease_ms: number | null
  enabled: boolean
  revision: string
  shared: unknown
}

const columns = `t.id,t.public_id::text,t.name,t.host,t.node,t.helper,t.helper_hash,t.workspace,
  t.bootstrap_path,t.bootstrap_hash,t.password_ref,t.request_timeout_ms,t.max_frame_bytes,t.max_pending,t.lease_ms,
  t.enabled,t.revision::text,
  (SELECT COALESCE(jsonb_agg(p.public_id ORDER BY p.public_id), '[]'::jsonb)
    FROM harness.ssh_target_shares s JOIN harness.projects p
      ON p.organization_id=s.organization_id AND p.id=s.project_id
    WHERE s.organization_id=t.organization_id AND s.target_id=t.id) shared`

function view(row: TargetRow): SshTargetView {
  const shared = Array.isArray(row.shared)
    ? row.shared.map(value => Number(value)).filter(value => Number.isSafeInteger(value))
    : []
  return {
    publicId: Number(row.public_id), name: row.name, host: row.host, node: row.node,
    helper: row.helper, helperHash: row.helper_hash, workspace: row.workspace,
    bootstrapPath: row.bootstrap_path, bootstrapHash: row.bootstrap_hash, passwordRef: row.password_ref,
    requestTimeoutMs: row.request_timeout_ms, maxFrameBytes: row.max_frame_bytes,
    maxPending: row.max_pending, leaseMs: row.lease_ms, enabled: row.enabled,
    revision: row.revision, sharedProjects: shared,
  }
}

/** Target registration and sharing; qualification itself lives in {@link ResourceAccess}. */
export class PostgresSshTargetService {
  constructor(private readonly context: PostgresRuntimeContext) {}

  /** Run one transaction, translating a raced name uniqueness violation into a conflict. */
  private async run<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await transaction(this.context.pool, work)
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') {
        throw new SshTargetError(409, 'ssh target name is already registered')
      }
      throw error
    }
  }

  /** @returns every registered target with its project shares, ordered by name. */
  async list(): Promise<SshTargetView[]> {
    const rows = await this.context.pool.query<TargetRow>(
      `SELECT ${columns} FROM harness.ssh_targets t WHERE t.organization_id=$1 ORDER BY t.name,t.public_id`,
      [this.context.organizationId])
    return rows.rows.map(view)
  }

  /**
   * List every target with its share state toward ONE project, for that
   * project's self-service sharing view. The actor must hold project
   * management authority — organization administration or ownership of the
   * project — revalidated on the locked project row inside the same
   * transaction that reads the catalog, so a concurrent owner change cannot
   * slip between admission and the listing.
   * @param actorPublicId - acting account's public id.
   * @param projectPublicId - project the share flags are read against.
   * @returns project-scoped target rows ordered by name.
   */
  async listForProject(actorPublicId: number, projectPublicId: number): Promise<ProjectSshTargetView[]> {
    return this.run(async client => {
      const actor = await client.query<{ id: string; administrator: boolean }>(`SELECT u.id,
        m.role='admin' administrator FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
          AND m.status='active' FOR SHARE OF u,m`,
      [this.context.organizationId, actorPublicId])
      const acting = actor.rows[0]
      if (acting === undefined) throw new SshTargetError(403, 'ssh share actor is unavailable')
      const project = await client.query<{ id: string; owner_user_id: string | null }>(
        `SELECT id,owner_user_id FROM harness.projects
        WHERE organization_id=$1 AND public_id=$2 AND status='active' FOR UPDATE`,
        [this.context.organizationId, projectPublicId])
      if (project.rows[0] === undefined) throw new SshTargetError(404, 'project not found')
      if (!acting.administrator && project.rows[0].owner_user_id !== acting.id) {
        throw new SshTargetError(403, 'ssh sharing requires project management authority')
      }
      const rows = await client.query<{
        public_id: string; name: string; host: string; workspace: string; enabled: boolean; shared: boolean
      }>(
        `SELECT t.public_id::text,t.name,t.host,t.workspace,t.enabled,
          EXISTS(SELECT 1 FROM harness.ssh_target_shares s
            WHERE s.organization_id=t.organization_id AND s.target_id=t.id AND s.project_id=$2) shared
          FROM harness.ssh_targets t WHERE t.organization_id=$1
          ORDER BY t.name,t.public_id`,
        [this.context.organizationId, project.rows[0].id])
      return rows.rows.map(row => ({
        publicId: Number(row.public_id), name: row.name, host: row.host,
        workspace: row.workspace, enabled: row.enabled, shared: row.shared,
      }))
    })
  }

  /**
   * Register one OpenSSH target.
   * @param adminPublicId - administrator creating the record.
   * @param input - validated connection coordinates.
   * @returns the created target.
   */
  async create(adminPublicId: number, input: unknown): Promise<SshTargetView> {
    const parsed = fields.safeParse(input)
    if (!parsed.success) throw new SshTargetError(400, 'invalid ssh target')
    const value = parsed.data
    return this.run(async client => {
      const creator = await client.query<{ id: string }>(
        'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',
        [this.context.organizationId, adminPublicId])
      const existing = await client.query('SELECT 1 FROM harness.ssh_targets WHERE organization_id=$1 AND name=$2',
        [this.context.organizationId, value.name])
      if (existing.rowCount !== 0) throw new SshTargetError(409, 'ssh target name is already registered')
      const inserted = await client.query<{ public_id: string }>(`INSERT INTO harness.ssh_targets
        (organization_id,name,host,node,helper,helper_hash,workspace,bootstrap_path,bootstrap_hash,
          password_ref,request_timeout_ms,max_frame_bytes,max_pending,lease_ms,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING public_id::text`,
      [this.context.organizationId, value.name, value.host, value.node, value.helper, value.helperHash,
        value.workspace, value.bootstrapPath ?? null, value.bootstrapHash ?? null,
        value.passwordRef ?? null, value.requestTimeoutMs ?? null, value.maxFrameBytes ?? null,
        value.maxPending ?? null, value.leaseMs ?? null, creator.rows[0]?.id ?? null])
      const created = await client.query<TargetRow>(
        `SELECT ${columns} FROM harness.ssh_targets t WHERE t.organization_id=$1 AND t.public_id=$2`,
        [this.context.organizationId, inserted.rows[0]!.public_id])
      return view(created.rows[0]!)
    })
  }

  /**
   * Replace one target's coordinates only when the submitted revision is current.
   * @param input - public target id, observed revision, and complete new field set.
   * @returns the updated target.
   */
  async update(input: unknown): Promise<SshTargetView> {
    const parsed = identity.extend({ fields }).safeParse(input)
    if (!parsed.success) throw new SshTargetError(400, 'invalid ssh target update')
    const { targetId, revision, fields: value } = parsed.data
    return this.run(async client => {
      const current = await client.query<{ revision: string }>(
        `SELECT revision::text FROM harness.ssh_targets WHERE organization_id=$1 AND public_id=$2 FOR UPDATE`,
        [this.context.organizationId, targetId])
      const row = current.rows[0]
      if (row === undefined) throw new SshTargetError(404, 'ssh target not found')
      if (row.revision !== revision) throw new SshTargetError(409, 'ssh target changed; reload before saving')
      const renamed = await client.query(
        'SELECT 1 FROM harness.ssh_targets WHERE organization_id=$1 AND name=$2 AND public_id<>$3',
        [this.context.organizationId, value.name, targetId])
      if (renamed.rowCount !== 0) throw new SshTargetError(409, 'ssh target name is already registered')
      await client.query(`UPDATE harness.ssh_targets SET
        name=$3,host=$4,node=$5,helper=$6,helper_hash=$7,workspace=$8,bootstrap_path=$9,bootstrap_hash=$10,
        password_ref=$11,request_timeout_ms=$12,max_frame_bytes=$13,max_pending=$14,lease_ms=$15,
        revision=revision+1,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND public_id=$2`,
      [this.context.organizationId, targetId, value.name, value.host, value.node, value.helper,
        value.helperHash, value.workspace, value.bootstrapPath ?? null, value.bootstrapHash ?? null,
        value.passwordRef ?? null, value.requestTimeoutMs ?? null, value.maxFrameBytes ?? null,
        value.maxPending ?? null, value.leaseMs ?? null])
      const updated = await client.query<TargetRow>(
        `SELECT ${columns} FROM harness.ssh_targets t WHERE t.organization_id=$1 AND t.public_id=$2`,
        [this.context.organizationId, targetId])
      return view(updated.rows[0]!)
    })
  }

  /**
   * Enable, disable, or remove one target under its observed revision.
   * @param input - public target id, observed revision, and the requested mutation.
   * @returns the updated target, or null after removal.
   */
  async mutate(input: unknown): Promise<SshTargetView | null> {
    const parsed = identity.extend({
      action: z.enum(['enable', 'disable', 'remove']),
    }).strict().safeParse(input)
    if (!parsed.success) throw new SshTargetError(400, 'invalid ssh target mutation')
    const { targetId, revision, action } = parsed.data
    return this.run(async client => {
      const current = await client.query<{ revision: string }>(
        'SELECT revision::text FROM harness.ssh_targets WHERE organization_id=$1 AND public_id=$2 FOR UPDATE',
        [this.context.organizationId, targetId])
      const row = current.rows[0]
      if (row === undefined) throw new SshTargetError(404, 'ssh target not found')
      if (row.revision !== revision) throw new SshTargetError(409, 'ssh target changed; reload before saving')
      if (action === 'remove') {
        await client.query('DELETE FROM harness.ssh_targets WHERE organization_id=$1 AND public_id=$2',
          [this.context.organizationId, targetId])
        return null
      }
      await client.query(`UPDATE harness.ssh_targets SET enabled=$3,
        revision=revision+1,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND public_id=$2`,
      [this.context.organizationId, targetId, action === 'enable'])
      const updated = await client.query<TargetRow>(
        `SELECT ${columns} FROM harness.ssh_targets t WHERE t.organization_id=$1 AND t.public_id=$2`,
        [this.context.organizationId, targetId])
      return view(updated.rows[0]!)
    })
  }

  /**
   * Share or unshare one target with a project. The actor must hold project
   * management authority — organization administration or ownership of the
   * receiving project — revalidated on the locked project row inside the same
   * transaction that writes the share, so a concurrent owner change cannot slip
   * between admission and mutation. Ordinary members cannot widen sharing.
   * @param actorPublicId - acting account's public id.
   * @param input - public target and project ids plus the share direction.
   * @returns the updated target.
   */
  async share(actorPublicId: number, input: unknown): Promise<SshTargetView> {
    const parsed = shareInput.extend({ shared: z.boolean() }).strict().safeParse(input)
    if (!parsed.success) throw new SshTargetError(400, 'invalid ssh share request')
    const { targetId, projectId, shared } = parsed.data
    return this.run(async client => {
      const actor = await client.query<{ id: string; administrator: boolean }>(`SELECT u.id,
        m.role='admin' administrator FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
          AND m.status='active' FOR SHARE OF u,m`,
      [this.context.organizationId, actorPublicId])
      const acting = actor.rows[0]
      if (acting === undefined) throw new SshTargetError(403, 'ssh share actor is unavailable')
      const project = await client.query<{ id: string; owner_user_id: string | null }>(
        `SELECT id,owner_user_id FROM harness.projects
        WHERE organization_id=$1 AND public_id=$2 AND status='active' FOR UPDATE`,
        [this.context.organizationId, projectId])
      const target = await client.query<{ id: string }>(
        'SELECT id FROM harness.ssh_targets WHERE organization_id=$1 AND public_id=$2 FOR UPDATE',
        [this.context.organizationId, targetId])
      if (project.rows[0] === undefined) throw new SshTargetError(404, 'project not found')
      if (target.rows[0] === undefined) throw new SshTargetError(404, 'ssh target not found')
      if (!acting.administrator && project.rows[0].owner_user_id !== acting.id) {
        throw new SshTargetError(403, 'ssh sharing requires project management authority')
      }
      if (shared) {
        await client.query(`INSERT INTO harness.ssh_target_shares(organization_id,target_id,project_id,created_by)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [this.context.organizationId, target.rows[0].id, project.rows[0].id, acting.id])
      } else {
        await client.query(`DELETE FROM harness.ssh_target_shares WHERE organization_id=$1 AND target_id=$2 AND project_id=$3`,
          [this.context.organizationId, target.rows[0].id, project.rows[0].id])
      }
      const updated = await client.query<TargetRow>(
        `SELECT ${columns} FROM harness.ssh_targets t WHERE t.organization_id=$1 AND t.public_id=$2`,
        [this.context.organizationId, targetId])
      return view(updated.rows[0]!)
    })
  }

  /**
   * Read one enabled target's connection fields for the signed interactive caller.
   * The caller's account, runtime scope, qualifications, and the target's enabled
   * state and project share are checked in the same transaction that reads the row,
   * so a revocation cannot slip between admission and configuration release.
   * @param input - public target id, signed caller public id, and the runtime scope.
   * @returns the server-confirmed caller id and the connection configuration.
   */
  async resolveForRuntime(input: {
    targetId: unknown
    actorPublicId: number
    runtimeKind: 'user' | 'project'
    runtimeId: number
    projectInternalId: string | undefined
  }): Promise<{ userId: number; config: ResolvedSshTarget }> {
    const parsed = z.number().int().positive().safeParse(input.targetId)
    if (!parsed.success) throw new SshTargetError(400, 'invalid ssh target id')
    return this.run(async client => {
      const actor = await client.query<{ id: string; public_id: string }>(`SELECT u.id,u.public_id::text
        FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        JOIN harness.organizations o ON o.id=u.organization_id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
          AND m.status='active' AND o.status='active' FOR SHARE OF u,m`,
        [this.context.organizationId, input.actorPublicId])
      const actorRow = actor.rows[0]
      if (actorRow === undefined) throw new SshTargetError(403, 'ssh actor is unavailable')
      if (input.runtimeKind === 'user') {
        if (publicNumber(actorRow.public_id, 'ssh actor') !== input.runtimeId) {
          throw new SshTargetError(403, 'personal execution cannot borrow another account')
        }
      } else {
        const membership = await client.query<{ administrator: boolean }>(
          `SELECT m.role='admin' administrator FROM harness.memberships m
          WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='active' FOR SHARE`,
        [this.context.organizationId, actorRow.id])
        const grant = membership.rows[0]
        if (grant === undefined) throw new SshTargetError(403, 'ssh actor cannot write in this project')
        if (!grant.administrator) {
          const member = await client.query<{ access_mode: string }>(
            `SELECT access_mode FROM harness.project_members
            WHERE organization_id=$1 AND project_id=$2 AND user_id=$3 FOR SHARE`,
          [this.context.organizationId, input.projectInternalId, actorRow.id])
          if (member.rows[0]?.access_mode !== 'rw') {
            throw new SshTargetError(403, 'ssh actor cannot write in this project')
          }
        }
      }
      const policies = await client.query<{ user_id: string | null }>(`SELECT user_id FROM harness.ssh_access_policies
        WHERE organization_id=$1 AND (user_id=$2 OR project_id=$3) AND enabled FOR SHARE`,
      [this.context.organizationId, actorRow.id, input.projectInternalId ?? null])
      if (!policies.rows.some(policy => policy.user_id === actorRow.id)) {
        throw new SshTargetError(403, 'an execution actor lacks ssh qualification')
      }
      if (input.runtimeKind === 'project' && !policies.rows.some(policy => policy.user_id === null)) {
        throw new SshTargetError(403, 'ssh access is not enabled for this project')
      }
      const rows = await client.query<TargetRow>(
        `SELECT ${columns} FROM harness.ssh_targets t WHERE t.organization_id=$1 AND t.public_id=$2 FOR SHARE`,
        [this.context.organizationId, parsed.data])
      const row = rows.rows[0]
      if (row === undefined || !row.enabled) throw new SshTargetError(404, 'ssh target not found')
      if (input.projectInternalId !== undefined) {
        const sharedRow = await client.query(
          'SELECT 1 FROM harness.ssh_target_shares WHERE organization_id=$1 AND target_id=$2 AND project_id=$3',
          [this.context.organizationId, row.id, input.projectInternalId])
        if (sharedRow.rowCount !== 1) throw new SshTargetError(403, 'ssh target is not shared with this project')
      }
      return {
        userId: publicNumber(actorRow.public_id, 'ssh actor'),
        config: {
          host: row.host, node: row.node, helper: row.helper, helperHash: row.helper_hash,
          workspace: row.workspace,
          ...(row.bootstrap_path === null ? {} : { bootstrapPath: row.bootstrap_path, bootstrapHash: row.bootstrap_hash! }),
          ...(row.password_ref === null ? {} : { passwordRef: row.password_ref }),
          ...(row.request_timeout_ms === null ? {} : { requestTimeoutMs: row.request_timeout_ms }),
          ...(row.max_frame_bytes === null ? {} : { maxFrameBytes: row.max_frame_bytes }),
          ...(row.max_pending === null ? {} : { maxPending: row.max_pending }),
          ...(row.lease_ms === null ? {} : { leaseMs: row.lease_ms }),
        },
      }
    })
  }
}
