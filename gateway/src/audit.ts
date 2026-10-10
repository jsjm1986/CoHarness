import type Database from 'better-sqlite3'

export interface AuditRow {
  id: number
  ts: number
  userId: number | null
  /** Actor's current login name and display name; null when the actor is the system or a removed user. */
  username?: string | null
  displayName?: string | null
  action: string
  methodPath: string
  status: number | null
  ip: string
  detail: string
  /** Durable request result when the backing store records one. */
  outcome?: string
}

/** Coarse grouping so the console can page one audit concern at a time. */
export type AuditFamily = 'admin' | 'auth' | 'model' | 'steward' | 'api' | 'other'

/** Filters accepted by both audit stores; stores clamp `limit` and floor `offset`. */
export interface AuditQueryFilter {
  userId?: number
  /** Login or display name substring match. */
  actor?: string
  /** Action match pattern; `%` and `_` are honored LIKE wildcards. */
  action?: string
  /** Literal action prefix; wildcard characters are escaped, not honored. */
  actionPrefix?: string
  /** Literal action substring; wildcard characters are escaped, not honored. */
  queryText?: string
  family?: AuditFamily
  outcome?: 'success' | 'failure'
  fromMs?: number
  toMs?: number
  offset?: number
  limit?: number
}

const MAX_LIMIT = 500

/** Action names whose durable suffix already declares the failed result. */
const FAILURE_ACTION_SUFFIX = /(?:\.(?:failed|denied|locked|error)|-failed)$/

/**
 * Durable outcome for one audit row: the HTTP status when the row records a
 * request, otherwise the result declared by the action name.
 * @param action - durable audit action.
 * @param status - HTTP status recorded for request rows.
 * @returns the outcome stored and filtered on.
 */
export function auditOutcome(action: string, status: number | undefined): 'success' | 'failure' {
  if (status !== undefined) return status >= 400 ? 'failure' : 'success'
  return FAILURE_ACTION_SUFFIX.test(action) ? 'failure' : 'success'
}

/** LIKE literal escaping shared by the local store; ESCAPE '\\' accompanies every use. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

const AUTH_FAMILY = `audit_log.action='login' OR audit_log.action LIKE 'login.%' OR audit_log.action LIKE 'logout%' OR audit_log.action LIKE 'password.%'`
const FAMILY_CLAUSES: Record<AuditFamily, string> = {
  admin: `audit_log.action LIKE 'admin.%'`,
  auth: `(${AUTH_FAMILY})`,
  model: `audit_log.action LIKE 'model.%'`,
  steward: `audit_log.action LIKE 'steward.%'`,
  api: `audit_log.action = 'api'`,
  other: `audit_log.action NOT LIKE 'admin.%' AND NOT (${AUTH_FAMILY}) AND audit_log.action NOT LIKE 'model.%' AND audit_log.action NOT LIKE 'steward.%' AND audit_log.action <> 'api'`,
}

function whereClauses(filter: AuditQueryFilter): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.userId !== undefined) { clauses.push('audit_log.user_id = ?'); params.push(filter.userId) }
  if (filter.actor !== undefined) {
    clauses.push(`(users.username LIKE ? ESCAPE '\\' OR users.display_name LIKE ? ESCAPE '\\')`)
    params.push(`%${escapeLike(filter.actor)}%`, `%${escapeLike(filter.actor)}%`)
  }
  if (filter.action !== undefined) { clauses.push('audit_log.action LIKE ?'); params.push(filter.action) }
  if (filter.actionPrefix !== undefined) { clauses.push(`audit_log.action LIKE ? ESCAPE '\\'`); params.push(`${escapeLike(filter.actionPrefix)}%`) }
  if (filter.queryText !== undefined) { clauses.push(`audit_log.action LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(filter.queryText)}%`) }
  if (filter.family !== undefined) clauses.push(FAMILY_CLAUSES[filter.family])
  const failureMatch = `(COALESCE(audit_log.status, 0) >= 400 OR audit_log.action LIKE '%.failed' ESCAPE '\\' OR audit_log.action LIKE '%.denied' ESCAPE '\\' OR audit_log.action LIKE '%.locked' ESCAPE '\\' OR audit_log.action LIKE '%.error' ESCAPE '\\' OR audit_log.action LIKE '%-failed' ESCAPE '\\')`
  if (filter.outcome === 'failure') clauses.push(failureMatch)
  else if (filter.outcome === 'success') clauses.push(`NOT ${failureMatch}`)
  if (filter.fromMs !== undefined) { clauses.push('audit_log.ts >= ?'); params.push(filter.fromMs) }
  if (filter.toMs !== undefined) { clauses.push('audit_log.ts <= ?'); params.push(filter.toMs) }
  return { clauses, params }
}

export class AuditService {
  constructor(private readonly db: Database.Database) {}

  write(entry: { userId?: number; action: string; methodPath?: string; status?: number; ip?: string; detail?: string }): void {
    this.db.prepare(
      `INSERT INTO audit_log(ts, user_id, action, method_path, status, ip, detail) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(Date.now(), entry.userId ?? null, entry.action, entry.methodPath ?? '', entry.status ?? null, entry.ip ?? '', entry.detail ?? '')
  }

  /**
   * Filtered audit history, newest first.
   * @param filter - actor, action, family, result and window constraints; `limit` is clamped to 500.
   * @returns matching rows with the actor's username and display name joined.
   */
  query(filter: AuditQueryFilter = {}): AuditRow[] {
    const { clauses, params } = whereClauses(filter)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(
      `SELECT audit_log.*, users.username, users.display_name FROM audit_log
       LEFT JOIN users ON users.id = audit_log.user_id
       ${where} ORDER BY audit_log.id DESC LIMIT ? OFFSET ?`,
    ).all(...params, Math.min(Math.max(filter.limit ?? 200, 1), MAX_LIMIT), Math.max(filter.offset ?? 0, 0)) as
      Array<{ id: number; ts: number; user_id: number | null; username: string | null; display_name: string | null; action: string; method_path: string; status: number | null; ip: string; detail: string }>
    return rows.map(r => ({ id: r.id, ts: r.ts, userId: r.user_id, username: r.username, displayName: r.display_name, action: r.action, methodPath: r.method_path, status: r.status, ip: r.ip, detail: r.detail, outcome: auditOutcome(r.action, r.status ?? undefined) }))
  }

  /**
   * Count rows matching the same filter as {@link query}, for pagination totals.
   * @param filter - the same constraints accepted by {@link query}.
   * @returns the matching row count across all pages.
   */
  count(filter: AuditQueryFilter = {}): number {
    const { clauses, params } = whereClauses(filter)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const row = this.db.prepare(
      `SELECT count(*) n FROM audit_log LEFT JOIN users ON users.id = audit_log.user_id ${where}`,
    ).get(...params) as { n: number }
    return row.n
  }
}
