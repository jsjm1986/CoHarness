/** Transaction-owned current administrator authority for organization mutations. */
import type { PoolClient } from 'pg'
import { CollaborationDeniedError } from '../collaboration.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/**
 * Retain an available organization before its current active administrator account and membership until commit.
 * @param client - caller-owned transaction; no pool checkout is performed.
 * @param context - organization whose mutation is requested.
 * @param actorUserId - server-authenticated public account identifier.
 */
export async function lockAdministrator(client: Pick<PoolClient, 'query'>, context: Pick<PostgresRuntimeContext, 'organizationId'>, actorUserId: number): Promise<void> {
  const organization = await client.query("SELECT 1 FROM harness.organizations WHERE id=$1 AND status='active' FOR SHARE", [context.organizationId])
  if (organization.rowCount !== 1) throw new CollaborationDeniedError('forbidden')
  const current = await client.query<{ role: string; user_status: string; membership_status: string }>(`SELECT
    m.role,u.status user_status,m.status membership_status
    FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
    WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL FOR SHARE OF u,m`,
  [context.organizationId, actorUserId])
  const actor = current.rows[0]
  if (actor === undefined || actor.role !== 'admin' || actor.user_status !== 'active' || actor.membership_status !== 'active') {
    throw new CollaborationDeniedError('forbidden')
  }
}
