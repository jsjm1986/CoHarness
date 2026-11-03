/** PostgreSQL administrator retention for remote desktop administration files. @module */
import { RemoteDesktopServiceError, type RemoteDesktopAdministration } from '../remote-desktop-service.ts'
import { CollaborationDeniedError } from '../collaboration.ts'
import { transaction } from './database.ts'
import { lockAdministrator } from './administrator-authority.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/**
 * Bind remote desktop file operations to their current organization administrator.
 * @param context - server-owned organization and database.
 * @returns admission that retains organization, account and membership until file work settles.
 */
export function remoteDesktopAdministration(context: PostgresRuntimeContext): RemoteDesktopAdministration {
  return {
    async run(actorUserId, operation) {
      try {
        return await transaction(context.pool, async client => {
          const lifetime = new AbortController()
          const lost = (error: Error): void => { lifetime.abort(error) }
          client.on('error', lost)
          try {
            await lockAdministrator(client, context, actorUserId)
            const actor = await client.query<{ username: string }>(
              'SELECT username FROM harness.users WHERE organization_id=$1 AND public_id=$2', [context.organizationId, actorUserId])
            lifetime.signal.throwIfAborted()
            const result = await operation(actor.rows[0]!.username, lifetime.signal)
            lifetime.signal.throwIfAborted()
            return result
          } finally {
            client.removeListener('error', lost)
            lifetime.abort(new Error('remote-desktop-administration-settled'))
          }
        })
      } catch (error) {
        if (error instanceof CollaborationDeniedError) throw new RemoteDesktopServiceError(403, 'forbidden', { cause: error })
        if (error instanceof RemoteDesktopServiceError) throw error
        throw new RemoteDesktopServiceError(503, 'remote-desktop-administration-unavailable', { cause: error })
      }
    },
  }
}
