/** Node setting writes share the backup/restore exclusion and capture the live database generation. */
import type { NodeConfigurationMutationAuthority } from '../node-config-store.ts'
import { acquireDeploymentDataLock } from './deployment-lock.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/**
 * Bind local configuration mutation to its database's deployment lease.
 * @param context - server-confirmed current node and organization.
 * @returns serialization and epoch capture used while holding the lease.
 */
export function nodeConfigurationAuthority(context: PostgresRuntimeContext): NodeConfigurationMutationAuthority {
  return {
    async run(operation) {
      await using lease = await acquireDeploymentDataLock(context.pool)
      return await operation(lease.signal)
    },
    async writeEpoch() {
      const result = await context.pool.query<{ write_epoch: string }>('SELECT write_epoch::text FROM harness.cluster_control WHERE organization_id=$1', [context.organizationId])
      const epoch = result.rows[0]?.write_epoch
      if (epoch === undefined) throw new Error('node-configuration-write-epoch-unavailable')
      return epoch
    },
  }
}
