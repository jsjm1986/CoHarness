/** Retirement of numeric quota aliases left by legacy SQLite writes. @module */
import type Database from 'better-sqlite3'

/**
 * Remove an account's noncanonical quota keys without selecting another account's rows.
 * @param db - caller-owned SQLite write transaction.
 * @param userId - target account id; canonical decimal storage is retained.
 */
export function clearSqliteUserQuotaAliases(db: Database.Database, userId: number): void {
  const aliases = db.prepare("SELECT subject_id FROM model_quotas WHERE subject_type='user' AND subject_id<>?")
    .all(String(userId)) as Array<{ subject_id: string }>
  const remove = db.prepare("DELETE FROM model_quotas WHERE subject_type='user' AND subject_id=?")
  for (const { subject_id: subjectId } of aliases) {
    if (Number(subjectId) === userId) remove.run(subjectId)
  }
}
