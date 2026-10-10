import { isIP } from 'node:net'
import type { AuditFamily, AuditQueryFilter, AuditRow } from '../audit.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

const MAX_LIMIT = 500

function sourceIp(ip: string | undefined): string | null {
  const normalized = (ip ?? '').replace(/^::ffff:/, '')
  return isIP(normalized) === 0 ? null : normalized
}

function detailValue(detail: string | undefined): unknown {
  if (detail === undefined || detail === '') return ''
  try {
    return JSON.parse(detail) as unknown
  } catch {
    return detail
  }
}

/** LIKE literal escaping for administrator-supplied action text. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

const AUTH_FAMILY = `e.action='login' OR e.action LIKE 'login.%' OR e.action LIKE 'logout%' OR e.action LIKE 'password.%'`
const FAMILY_CLAUSES: Record<AuditFamily, string> = {
  admin: `e.action LIKE 'admin.%'`,
  auth: `(${AUTH_FAMILY})`,
  model: `e.action LIKE 'model.%'`,
  steward: `e.action LIKE 'steward.%'`,
  api: `e.action = 'api'`,
  other: `e.action NOT LIKE 'admin.%' AND NOT (${AUTH_FAMILY}) AND e.action NOT LIKE 'model.%' AND e.action NOT LIKE 'steward.%' AND e.action <> 'api'`,
}

function whereClauses(filter: AuditQueryFilter, organizationId: string): { clauses: string[]; values: unknown[] } {
  const clauses = ['e.organization_id=$1']
  const values: unknown[] = [organizationId]
  const add = (clause: string, ...clauseValues: unknown[]): void => {
    for (const value of clauseValues) {
      values.push(value)
      clause = clause.replace('?', `$${String(values.length)}`)
    }
    clauses.push(clause)
  }
  if (filter.userId !== undefined) add('u.public_id=?', filter.userId)
  if (filter.actor !== undefined) add(`(u.username ILIKE ? ESCAPE '\\' OR u.display_name ILIKE ? ESCAPE '\\')`, `%${escapeLike(filter.actor)}%`, `%${escapeLike(filter.actor)}%`)
  if (filter.action !== undefined) add('e.action LIKE ?', filter.action)
  if (filter.actionPrefix !== undefined) add(`e.action LIKE ? ESCAPE '\\'`, `${escapeLike(filter.actionPrefix)}%`)
  if (filter.queryText !== undefined) add(`e.action LIKE ? ESCAPE '\\'`, `%${escapeLike(filter.queryText)}%`)
  if (filter.family !== undefined) clauses.push(FAMILY_CLAUSES[filter.family])
  if (filter.outcome !== undefined) add('e.outcome=?', filter.outcome)
  if (filter.fromMs !== undefined) add('e.occurred_at >= to_timestamp(?/1000.0)', filter.fromMs)
  if (filter.toMs !== undefined) add('e.occurred_at <= to_timestamp(?/1000.0)', filter.toMs)
  return { clauses, values }
}

/** PostgreSQL-backed audit writer and filtered history for one organization. */
export class PostgresAuditService {
  constructor(private readonly context: PostgresRuntimeContext) {}

  async write(entry: {
    userId?: number
    action: string
    methodPath?: string
    status?: number
    ip?: string
    detail?: string
  }): Promise<void> {
    await this.context.pool.query(`INSERT INTO harness.audit_events(
      organization_id,actor_user_id,action,resource_type,source_ip,outcome,status_code,detail
    ) VALUES($1,(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2),$3,$4,$5,$6,$7,$8::jsonb)`, [
      this.context.organizationId,
      entry.userId ?? null,
      entry.action,
      entry.methodPath === undefined || entry.methodPath === '' ? null : 'http',
      sourceIp(entry.ip),
      entry.status !== undefined && entry.status >= 400 ? 'failure' : 'success',
      entry.status ?? null,
      JSON.stringify({ methodPath: entry.methodPath ?? '', detail: detailValue(entry.detail) }),
    ])
  }

  /**
   * Filtered audit history, newest first.
   * @param filter - actor, action, family, result and window constraints; `limit` is clamped to 500.
   * @returns matching rows with the actor's current username and display name joined.
   */
  async query(filter: AuditQueryFilter = {}): Promise<AuditRow[]> {
    const { clauses, values } = whereClauses(filter, this.context.organizationId)
    values.push(Math.min(Math.max(filter.limit ?? 200, 1), MAX_LIMIT))
    const limit = `$${String(values.length)}`
    values.push(Math.max(filter.offset ?? 0, 0))
    const offset = `$${String(values.length)}`
    const result = await this.context.pool.query<{
      id: string
      ts: string
      user_id: string | null
      username: string | null
      display_name: string | null
      action: string
      method_path: string
      status_code: number | null
      source_ip: string | null
      detail_text: string
      outcome: string
    }>(`SELECT e.id::text,(extract(epoch FROM e.occurred_at)*1000)::text ts,
      u.public_id::text user_id,u.username::text username,u.display_name,
      e.action,COALESCE(e.detail->>'methodPath','') method_path,
      e.status_code,host(e.source_ip) source_ip,e.outcome,
      CASE WHEN e.detail ? 'detail' THEN e.detail->>'detail'
        WHEN e.detail ? 'legacyDetail' THEN e.detail->>'legacyDetail' ELSE '' END detail_text
      FROM harness.audit_events e
      LEFT JOIN harness.users u ON u.id=e.actor_user_id AND u.organization_id=e.organization_id
      WHERE ${clauses.join(' AND ')} ORDER BY e.id DESC LIMIT ${limit} OFFSET ${offset}`, values)
    return result.rows.map(row => ({
      id: publicNumber(row.id, 'audit event'),
      ts: Number(row.ts),
      userId: row.user_id === null ? null : publicNumber(row.user_id, 'user'),
      username: row.username,
      displayName: row.display_name,
      action: row.action,
      methodPath: row.method_path,
      status: row.status_code,
      ip: row.source_ip ?? '',
      detail: row.detail_text,
      outcome: row.outcome,
    }))
  }

  /**
   * Count rows matching the same filter as {@link query}, for pagination totals.
   * @param filter - the same constraints accepted by {@link query}.
   * @returns the matching row count across all pages.
   */
  async count(filter: AuditQueryFilter = {}): Promise<number> {
    const { clauses, values } = whereClauses(filter, this.context.organizationId)
    const result = await this.context.pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM harness.audit_events e
       LEFT JOIN harness.users u ON u.id=e.actor_user_id AND u.organization_id=e.organization_id
       WHERE ${clauses.join(' AND ')}`, values)
    return Number(result.rows[0]?.n ?? 0)
  }
}
