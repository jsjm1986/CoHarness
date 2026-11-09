/** Current administrator authority for the local SQLite service adapter. */
import type Database from 'better-sqlite3'
import { CollaborationDeniedError } from './collaboration.ts'

/**
 * Check current administrator and completed password requirement in the immediate transaction before its first effect.
 * @param database - transaction-owned SQLite connection.
 * @param actorUserId - server-authenticated administrator identifier.
 */
export function requireSqliteAdministrator(database: Database.Database, actorUserId: number): void {
  const current = database.prepare(`SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active'
    AND deleted_at IS NULL AND must_change_password=0`).get(actorUserId)
  if (current === undefined) throw new CollaborationDeniedError('forbidden')
}
