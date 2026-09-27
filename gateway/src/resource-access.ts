/** Administrator-owned resource qualification, separate from per-Session confirmation and leases. */
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'

/** The account or project whose resource qualification is being configured. */
export interface ResourcePolicyOwner { kind: 'user' | 'project'; id: number }
/** Revision zero represents an absent policy and denies access by default. */
export interface ResourceAccessPolicy extends ResourcePolicyOwner { enabled: boolean; revision: string }

/** A policy request was invalid, stale, or addressed a missing owner. */
export class ResourceAccessError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}

/**
 * Validate owner coordinates received from an administrative API.
 * @param kind - requested account or project scope.
 * @param id - public owner identifier from the request.
 * @returns validated coordinates within the server-owned organization.
 */
export function resourcePolicyOwner(kind: unknown, id: unknown, resource: 'desktop' | 'terminal' | 'ssh'): ResourcePolicyOwner {
  if ((kind !== 'user' && kind !== 'project') || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new ResourceAccessError(400, `invalid ${resource} policy owner`)
  }
  return { kind, id }
}

/** PostgreSQL owns revisions and publishes changes to the existing access outbox. */
export class ResourceAccess {
  constructor(private readonly context: PostgresRuntimeContext, private readonly resource: 'desktop' | 'terminal' | 'ssh') {}

  /**
   * Read the current decision, retaining a false default for unconfigured owners.
   * @param owner - account or project within this organization.
   * @returns the saved policy or the revision-zero default.
   */
  async get(owner: ResourcePolicyOwner): Promise<ResourceAccessPolicy> {
    const table = owner.kind === 'user' ? 'users' : 'projects'
    const column = owner.kind === 'user' ? 'user_id' : 'project_id'
    const result = await this.context.pool.query<{ enabled: boolean | null; revision: string | null }>(
      `SELECT p.enabled,p.revision::text FROM harness.${table} o LEFT JOIN harness.${this.resource}_access_policies p
        ON p.organization_id=o.organization_id AND p.${column}=o.id
        WHERE o.organization_id=$1 AND o.public_id=$2 ${owner.kind === 'user' ? 'AND o.deleted_at IS NULL' : ''}`,
      [this.context.organizationId, owner.id],
    )
    const row = result.rows[0]
    if (row === undefined) throw new ResourceAccessError(404, `${this.resource} policy owner not found`)
    return { ...owner, enabled: row.enabled ?? false, revision: row.revision ?? '0' }
  }

  /**
   * Atomically change a decision only when its submitted revision is still current.
   * @param owner - account or project within this organization.
   * @param enabled - requested administrator decision, validated as a boolean.
   * @param revision - decimal version observed by the editor.
   * @returns the committed decision and version.
   */
  async set(owner: ResourcePolicyOwner, enabled: unknown, revision: unknown): Promise<ResourceAccessPolicy> {
    if (typeof enabled !== 'boolean' || typeof revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(revision)) {
      throw new ResourceAccessError(400, `invalid ${this.resource} policy value or revision`)
    }
    const table = owner.kind === 'user' ? 'users' : 'projects'
    const column = owner.kind === 'user' ? 'user_id' : 'project_id'
    return transaction(this.context.pool, async (client) => {
      const owners = await client.query<{ id: string }>(`SELECT id FROM harness.${table}
        WHERE organization_id=$1 AND public_id=$2 ${owner.kind === 'user' ? 'AND deleted_at IS NULL' : ''} FOR UPDATE`,
      [this.context.organizationId, owner.id])
      const id = owners.rows[0]?.id
      if (id === undefined) throw new ResourceAccessError(404, `${this.resource} policy owner not found`)
      const rows = await client.query<{ enabled: boolean; revision: string }>(`SELECT enabled,revision::text
        FROM harness.${this.resource}_access_policies WHERE organization_id=$1 AND ${column}=$2 FOR UPDATE`,
      [this.context.organizationId, id])
      const current = rows.rows[0]
      if ((current?.revision ?? '0') !== revision) throw new ResourceAccessError(409, `${this.resource} policy changed; reload before saving`)
      if (current?.enabled === enabled) return { ...owner, enabled, revision }
      const result = current === undefined
        ? await client.query<{ revision: string }>(`INSERT INTO harness.${this.resource}_access_policies(organization_id,${column},enabled,revision)
            VALUES($1,$2,$3,1) RETURNING revision::text`, [this.context.organizationId, id, enabled])
        : await client.query<{ revision: string }>(`UPDATE harness.${this.resource}_access_policies SET enabled=$3,revision=revision+1
            WHERE organization_id=$1 AND ${column}=$2 RETURNING revision::text`, [this.context.organizationId, id, enabled])
      return { ...owner, enabled, revision: result.rows[0]!.revision }
    })
  }
}
