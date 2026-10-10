/** Administrator-owned steward-space qualifications for accounts. */
import type { PoolClient } from 'pg'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { ResourceAccess, ResourceAccessError, resourcePolicyOwner } from './resource-access.ts'
import type { ResourceAccessPolicy, ResourcePolicyOwner } from './resource-access.ts'
export { ResourceAccessError as StewardAccessError } from './resource-access.ts'
export type { ResourcePolicyOwner as StewardPolicyOwner, ResourceAccessPolicy as StewardAccessPolicy } from './resource-access.ts'

/** One organization member's steward qualification as the admin surface lists it. */
export interface StewardAccessEntry {
  /** Public user id, reused as the policy owner id for writes. */
  userId: number
  username: string
  displayName: string
  role: 'admin' | 'member'
  /** Account lifecycle state; anything but `active` disqualifies entry. */
  userStatus: string
  /** Membership lifecycle state; anything but `active` disqualifies entry. */
  membershipStatus: string
  /** Whether the account may hold a qualification at all. */
  grantable: boolean
  /** Whether an enabled policy row exists, regardless of current eligibility. */
  qualified: boolean
  /** Whether the account can enter the steward space right now: admin ∧ enabled grant. */
  effective: boolean
  /** Current policy revision for fenced writes; `'0'` when no row exists. */
  revision: string
}

/**
 * Validate steward policy coordinates. Steward admission is user-scoped only:
 * the reserved project's membership list stays empty, so a project-scoped row
 * can never describe who may enter.
 * @param kind - owner coordinate; only `user` is accepted.
 * @param id - public user identifier in the active organization.
 * @param lane - resource lane name; must be `steward`.
 * @returns validated policy coordinates.
 */
export function stewardPolicyOwner(kind: unknown, id: unknown, lane?: unknown) {
  if (lane !== undefined && lane !== 'steward') throw new ResourceAccessError(400, 'invalid steward resource lane')
  const owner = resourcePolicyOwner(kind, id, 'steward')
  if (owner.kind !== 'user') throw new ResourceAccessError(400, 'steward policies are user-scoped')
  return owner
}

/** Versioned steward-space decisions layered on top of administrator membership. */
export class StewardAccess extends ResourceAccess {
  constructor(private readonly pg: PostgresRuntimeContext) { super(pg, 'steward') }

  /**
   * Enabling a steward qualification requires the owner to already hold an
   * active administrator membership — the space maintains the deployment
   * itself, so the lane layers on admin rather than replacing it. The check
   * runs inside the policy transaction; revocation stays open so a stale or
   * post-downgrade row can always be cleared. The runtime predicate re-checks
   * the role on every admission, which keeps a grant raced against a role
   * change ineffective even if this check observed an earlier snapshot.
   * @param client - the open policy transaction with the owner row locked.
   * @param owner - user owner; project owners are rejected by the lane.
   * @param internalId - the owner's `users.id` inside this organization.
   */
  protected override async checkEnabledOwner(client: PoolClient, owner: ResourcePolicyOwner, internalId: string): Promise<void> {
    if (owner.kind !== 'user') return
    const result = await client.query(
      `SELECT 1 FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.id=$1 AND u.status='active' AND m.status='active' AND m.role='admin'`,
      [internalId])
    if (result.rows.length !== 1) {
      throw new ResourceAccessError(409, 'steward qualification requires an active organization administrator')
    }
  }

  /**
   * List every organization member's steward qualification for the admin
   * surface, joining the membership facts that decide effectiveness.
   * @returns member rows ordered for review: effective first, then stale grants, then administrators.
   */
  async list(): Promise<StewardAccessEntry[]> {
    const result = await this.pg.pool.query<{
      public_id: string
      username: string
      display_name: string
      role: 'admin' | 'member'
      user_status: string
      membership_status: string
      enabled: boolean | null
      revision: string | null
    }>(`SELECT u.public_id::text,u.username,u.display_name,u.status user_status,
      m.role,m.status membership_status,sp.enabled,sp.revision::text
      FROM harness.users u
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      LEFT JOIN harness.steward_access_policies sp ON sp.organization_id=u.organization_id AND sp.user_id=u.id
      WHERE u.organization_id=$1 AND u.deleted_at IS NULL
      ORDER BY (m.status='active' AND m.role='admin' AND COALESCE(sp.enabled,false)) DESC,
        COALESCE(sp.enabled,false) DESC, m.role='admin' DESC, u.public_id`,
    [this.pg.organizationId])
    return result.rows.map(row => {
      const adminActive = row.role === 'admin' && row.membership_status === 'active' && row.user_status === 'active'
      const qualified = row.enabled === true
      return {
        userId: Number(row.public_id),
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        userStatus: row.user_status,
        membershipStatus: row.membership_status,
        grantable: adminActive,
        qualified,
        effective: adminActive && qualified,
        revision: row.revision ?? '0',
      }
    })
  }
}
