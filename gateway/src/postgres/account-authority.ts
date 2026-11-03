/** Transaction-owned eligibility for account-scoped data. @module */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PoolClient } from 'pg'
import { CollaborationDeniedError } from '../collaboration.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/** Current account identity retained by a caller-owned transaction. */
export interface ActiveAccount {
  /** Internal organization-scoped PostgreSQL account UUID. */
  id: Branded<'PostgresAccountId'>
  /** Current username used for owned legacy account storage. */
  username: string
}

/**
 * Retain an active organization, nondeleted active account and active membership until commit.
 * @param client - caller-owned transaction connection; no additional checkout is performed.
 * @param context - account's organization; computer execution grants do not govern account data.
 * @param publicId - server-authenticated public account id.
 * @returns current identity; unavailable account eligibility rejects with forbidden.
 */
export async function lockActiveAccount(client: PoolClient, context: Pick<PostgresRuntimeContext, 'organizationId'>, publicId: number): Promise<ActiveAccount> {
  const organization = await client.query("SELECT 1 FROM harness.organizations WHERE id=$1 AND status='active' FOR SHARE", [context.organizationId])
  if (organization.rowCount !== 1) throw new CollaborationDeniedError('forbidden')
  const result = await client.query<ActiveAccount>(`SELECT u.id,u.username FROM harness.users u
    JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
    WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL AND u.status='active' AND m.status='active'
    FOR SHARE OF u,m`, [context.organizationId, publicId])
  const account = result.rows[0]
  if (account === undefined) throw new CollaborationDeniedError('forbidden')
  return account
}
