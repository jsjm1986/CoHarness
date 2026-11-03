/** Transaction-owned authorization for project management and credential preparation. */
import type { PoolClient } from 'pg'
import { CollaborationDeniedError } from '../collaboration.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

interface ManagementActor {
  id: string
  role: 'admin' | 'member'
  user_status: string
  membership_status: string
}

/**
 * Retain current management authority and the selected project until the caller commits.
 * @param client - caller-owned transaction; no other pool connection is acquired.
 * @param context - organization owning the project and acting account.
 * @param projectId - public project identifier.
 * @param actorUserId - authenticated browser actor; omitted permits trusted internal maintenance without a browser grant.
 * @param requiredRole - manager permits current owners; administrator requires the current organization role.
 * @returns the locked internal project id; account locks precede the project lock to match membership writers.
 */
export async function lockProjectManagement(
  client: PoolClient, context: Pick<PostgresRuntimeContext, 'organizationId'>, projectId: number, actorUserId?: number,
  requiredRole: 'manager' | 'administrator' = 'manager',
): Promise<string> {
  let actor: ManagementActor | undefined
  if (actorUserId !== undefined) {
    const current = await client.query<ManagementActor>(`SELECT u.id,m.role,
      u.status user_status,m.status membership_status
      FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL FOR SHARE OF u,m`,
    [context.organizationId, actorUserId])
    actor = current.rows[0]
    if (actor === undefined || actor.user_status !== 'active' || actor.membership_status !== 'active') {
      throw new CollaborationDeniedError('forbidden')
    }
    if (requiredRole === 'administrator' && actor.role !== 'admin') throw new CollaborationDeniedError('forbidden')
  }
  const projects = await client.query<{ id: string; owner_user_id: string | null; kind: 'standard' | 'steward'; status: string }>(
    `SELECT id,owner_user_id,kind,status FROM harness.projects
      WHERE organization_id=$1 AND public_id=$2 FOR UPDATE`, [context.organizationId, projectId])
  const project = projects.rows[0]
  if (project === undefined || project.status !== 'active') throw new Error(`unknown project ${String(projectId)}`)
  if (actor === undefined) return project.id
  const organization = await client.query(
    "SELECT 1 FROM harness.organizations WHERE id=$1 AND status='active'", [context.organizationId])
  if (organization.rowCount !== 1) throw new CollaborationDeniedError('forbidden')
  if (project.kind === 'steward') {
    const qualified = actor.role === 'admin' && (await client.query(`SELECT 1 FROM harness.steward_access_policies
      WHERE organization_id=$1 AND user_id=$2 AND node_id=harness.project_node_id($1,$3) AND enabled`, [context.organizationId, actor.id, project.id])).rowCount === 1
    if (!qualified) throw new CollaborationDeniedError('forbidden')
  } else if (actor.role !== 'admin') {
    if ((await client.query('SELECT harness.project_computer_use_allowed($1,$2,$3) allowed',
      [context.organizationId, actor.id, project.id])).rows[0]?.allowed !== true) throw new CollaborationDeniedError('forbidden')
    const member = actor.id === project.owner_user_id && (await client.query(`SELECT 1 FROM harness.project_members
      WHERE organization_id=$1 AND project_id=$2 AND user_id=$3 FOR SHARE`,
    [context.organizationId, project.id, actor.id])).rowCount === 1
    if (!member) throw new CollaborationDeniedError('forbidden')
  }
  return project.id
}
