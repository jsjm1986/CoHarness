/** Node settings retain administrator authority and the deployment data lease through publication. */
import { CollaborationDeniedError } from '../collaboration.ts'
import { NodeConfigurationError, type NodeConfigurationMutationAuthority } from '../node-config-store.ts'
import { lockAdministrator } from './administrator-authority.ts'
import { transaction } from './database.ts'
import { acquireDeploymentDataLock } from './deployment-lock.ts'
import { MaintenanceError } from './maintenance-service.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

function configurationFailure(error: unknown): Error {
  if (error instanceof NodeConfigurationError || error instanceof CollaborationDeniedError || error instanceof MaintenanceError) return error
  return new NodeConfigurationError(503, 'node-configuration-unavailable', { cause: error })
}

/**
 * Bind local configuration reads and writes to their current organization administrator.
 * @param context - server-confirmed current node and organization.
 * @returns retained authority, deployment exclusion and epoch capture on the same leased connection.
 */
export function nodeConfigurationAuthority(context: PostgresRuntimeContext): NodeConfigurationMutationAuthority {
  return {
    async authorize(actorUserId, operation) {
      try {
        return await transaction(context.pool, async client => {
          await lockAdministrator(client, context, actorUserId)
          return operation(client)
        })
      } catch (error) { throw configurationFailure(error) }
    },
    async run(actorUserId, operation) {
      try {
        await using lease = await acquireDeploymentDataLock(context.pool)
        await lease.query('BEGIN')
        try {
          if (actorUserId !== undefined) await lockAdministrator(lease, context, actorUserId)
          lease.signal.throwIfAborted()
          const result = await operation(lease.signal, async () => {
            lease.signal.throwIfAborted()
            const epoch = await lease.query<{ write_epoch: string }>(
              'SELECT write_epoch::text FROM harness.cluster_control WHERE organization_id=$1', [context.organizationId])
            if (epoch.rows[0] === undefined) throw new Error('node-configuration-write-epoch-unavailable')
            return epoch.rows[0].write_epoch
          }, lease)
          lease.signal.throwIfAborted()
          await lease.query('COMMIT')
          return result
        } catch (error) {
          try { await lease.query('ROLLBACK') } catch { /* A lost leased backend cannot roll back; preserve the work failure. */ }
          throw error
        }
      } catch (error) { throw configurationFailure(error) }
    },
  }
}
