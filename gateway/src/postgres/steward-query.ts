/** Audited SQL execution channel for the resident steward runtime. */
import type { PoolClient } from 'pg'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/** Rejected steward statements carry a wire status plus a stable code. */
export class StewardQueryError extends Error {
  constructor(readonly status: 400 | 403 | 413 | 503, readonly code: string, message: string) {
    super(message)
    this.name = 'StewardQueryError'
  }
}

const MAX_STATEMENT_BYTES = 64 * 1024
const DEFAULT_ROW_LIMIT = 500
const MAX_ROW_LIMIT = 5_000
const MAX_RESULT_BYTES = 256 * 1024
const STATEMENT_TIMEOUT_MS = 15_000
const APPROVAL_TTL_MINUTES = 15

const LEADING_NOISE = /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s)*/
const READONLY_HEAD = /^(select|with|values|table|show|explain)\b/i

/** Authenticated steward target coordinates carried by the runtime token. */
export interface StewardQuerySubject {
  organizationId: string
  projectInternalId: string
  generation: number
}

/** One steward query request as accepted from the steward tool surface. */
export interface StewardQueryInput {
  sql: string
  dryRun: boolean
  approvalId?: string
  rowLimit: number
}

export interface StewardQueryResult {
  classification: 'read' | 'write'
  dryRun: boolean
  columns: string[]
  rows: unknown[] | null
  plan: unknown[] | null
  rowCount: number | null
  truncated: boolean
}

/**
 * Statement classification gates which lane a statement enters; it is not the
 * write-safety boundary. Read-classified statements run inside a READ ONLY
 * transaction, so `EXPLAIN ANALYZE` and data-modifying CTEs that pass the
 * leading-keyword test still fail at execution and are audited as errors.
 */
function classify(sql: string): 'read' | 'write' {
  const stripped = sql.replace(LEADING_NOISE, '')
  return READONLY_HEAD.test(stripped) ? 'read' : 'write'
}

export class StewardQueryService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly enabled: boolean,
  ) {}

  /**
   * Verify the caller's runtime token resolves to the steward project.
   * @param projectInternalId - internal projects.id bound to the runtime token.
   * @returns true only while the steward space is enabled and the target row keeps kind='steward'.
   */
  async stewardTarget(projectInternalId: string | undefined): Promise<boolean> {
    if (!this.enabled || projectInternalId === undefined) return false
    const result = await this.context.pool.query(
      `SELECT 1 FROM harness.projects WHERE organization_id=$1 AND id=$2 AND kind='steward' AND status='active'`,
      [this.context.organizationId, projectInternalId],
    )
    return result.rows.length > 0
  }

  /**
   * Execute one audited statement for the steward runtime. Every attempt —
   * denied, failed, or applied — lands in `harness.steward_query_log`. Write
   * statements verify, execute, and journal inside one transaction: the
   * approval check locks the response row so an `allowed-once` verdict can
   * only ever green-light one write, and an audit-insert failure rolls the
   * statement back instead of leaving an unlogged write.
   * @param subject - steward project identity resolved from the runtime token.
   * @param input - statement plus dry-run and approval coordinates.
   * @returns columns/rows (capped) or an EXPLAIN plan for dry runs.
   */
  async query(subject: StewardQuerySubject, input: StewardQueryInput): Promise<StewardQueryResult> {
    const statement = input.sql
    if (Buffer.byteLength(statement, 'utf8') > MAX_STATEMENT_BYTES) {
      throw new StewardQueryError(413, 'steward-statement-too-large', `statement exceeds ${MAX_STATEMENT_BYTES} bytes`)
    }
    const classification = classify(statement)
    if (input.dryRun) {
      return this.explain(subject, statement, classification, input.approvalId)
    }
    if (classification === 'write' && input.approvalId === undefined) {
      await this.journal(subject, statement, classification, false, 'denied', null, null, null, 'approval-required', input.approvalId)
      throw new StewardQueryError(403, 'steward-approval-required', 'write statements require an approved in-session interaction')
    }

    const client = await this.context.pool.connect()
    try {
      await client.query(classification === 'read' ? 'BEGIN READ ONLY' : 'BEGIN')
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      let responderInternalId: string | null = null
      if (classification === 'write') {
        responderInternalId = await this.verifyApproval(client, input.approvalId!, subject.projectInternalId)
        if (responderInternalId === null) {
          await client.query('ROLLBACK')
          await this.journal(subject, statement, classification, false, 'denied', null, null, null, 'approval-invalid', input.approvalId)
          throw new StewardQueryError(403, 'steward-approval-invalid', 'the supplied approval interaction is missing, expired, spent, or unqualified')
        }
      }
      // Passing an empty params array keeps node-pg on the extended protocol,
      // which rejects multi-statement input at the protocol level.
      const result = await client.query(statement, [])
      const rows = classification === 'read' ? (result.rows as unknown[]).slice(0, input.rowLimit) : null
      let truncated = classification === 'read' && result.rows.length > input.rowLimit
      let serialized = rows === null ? null : JSON.stringify(rows)
      while (serialized !== null && serialized.length > MAX_RESULT_BYTES && Array.isArray(rows) && rows.length > 0) {
        rows.splice(Math.ceil(rows.length / 2))
        truncated = true
        serialized = JSON.stringify(rows)
      }
      const bytes = serialized?.length ?? 0
      const columns = (result.fields ?? []).map(field => field.name)
      const rowCount = result.rowCount ?? (rows?.length ?? 0)
      if (classification === 'write') {
        await client.query(`INSERT INTO harness.steward_query_log(
            organization_id,project_id,runtime_generation,statement,classification,dry_run,
            approval_interaction_id,responder_user_id,status,row_count,result_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ok',$9,$10)`, [
          this.context.organizationId, subject.projectInternalId, subject.generation, statement,
          classification, false, input.approvalId ?? null, responderInternalId, rowCount, bytes,
        ])
        await client.query('COMMIT')
      } else {
        await client.query('COMMIT')
        await this.journal(subject, statement, classification, false, 'ok', null, rowCount, bytes, null, input.approvalId)
      }
      return {
        classification,
        dryRun: false,
        columns,
        rows,
        plan: null,
        rowCount,
        truncated,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      await this.journal(subject, statement, classification, false, 'error', null, null, null, message, input.approvalId)
      throw error
    } finally {
      client.release()
    }
  }

  private async explain(subject: StewardQuerySubject, statement: string, classification: 'read' | 'write', approvalId: string | undefined): Promise<StewardQueryResult> {
    const client = await this.context.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      const result = await client.query(`EXPLAIN ${statement}`, [])
      await client.query('COMMIT')
      await this.journal(subject, statement, classification, true, 'ok', null, result.rows.length, null, null, approvalId)
      return { classification, dryRun: true, columns: ['QUERY PLAN'], rows: null, plan: result.rows, rowCount: result.rows.length, truncated: false }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      await this.journal(subject, statement, classification, true, 'error', null, null, null, message, approvalId)
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * A write needs a committed approval interaction that was raised inside a
   * conversation rooted in this steward project — an approval granted in any
   * other space does not carry over — whose responder still holds the steward
   * qualification, recorded inside the approval TTL. The advisory lock on the
   * approval id serializes concurrent writers: the second writer's follow-up
   * SELECT runs with a fresh READ COMMITTED snapshot and sees the first
   * write's committed audit row, so an `allowed-once` verdict green-lights
   * exactly one write. The outcome column stores the literal wire verdict
   * `'allowed-once'`.
   */
  private async verifyApproval(client: PoolClient, approvalId: string, projectInternalId: string): Promise<string | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [approvalId])
    const result = await client.query<{ responder: string }>(`SELECT r.responder_user_id::text responder
      FROM harness.conversation_interaction_responses r
      JOIN harness.conversation_sessions c ON c.organization_id=r.organization_id AND c.id=r.conversation_id
      JOIN harness.conversation_sessions root ON root.organization_id=c.organization_id
        AND root.id=c.root_session_id AND root.project_id=$3
      JOIN harness.users u ON u.organization_id=r.organization_id AND u.id=r.responder_user_id AND u.status='active'
      JOIN harness.steward_access_policies sp ON sp.organization_id=u.organization_id AND sp.user_id=u.id AND sp.enabled
      WHERE r.organization_id=$1 AND r.interaction_kind='approval' AND r.interaction_id=$2
        AND r.responded_at > now() - interval '${APPROVAL_TTL_MINUTES} minutes'
        AND r.outcome = to_jsonb('allowed-once'::text)
        AND NOT EXISTS (
          SELECT 1 FROM harness.steward_query_log l
          WHERE l.organization_id=r.organization_id AND l.approval_interaction_id=r.interaction_id
            AND l.classification='write' AND l.dry_run=false AND l.status='ok')
      ORDER BY r.responded_at DESC LIMIT 1`,
    [this.context.organizationId, approvalId, projectInternalId])
    return result.rows[0]?.responder ?? null
  }

  /** Best-effort journal for attempts that never reached the transaction. */
  private async journal(
    subject: StewardQuerySubject,
    statement: string,
    classification: 'read' | 'write',
    dryRun: boolean,
    status: 'ok' | 'denied' | 'error',
    responderInternalId: string | null,
    rowCount: number | null,
    bytes: number | null,
    error: string | null,
    approvalId: string | undefined,
  ): Promise<void> {
    try {
      await this.context.pool.query(`INSERT INTO harness.steward_query_log(
          organization_id,project_id,runtime_generation,statement,classification,dry_run,
          approval_interaction_id,responder_user_id,status,row_count,result_bytes,error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
        this.context.organizationId, subject.projectInternalId, subject.generation, statement,
        classification, dryRun, approvalId ?? null, responderInternalId, status, rowCount, bytes, error,
      ])
    } catch (journalError) {
      console.error('[gateway] steward query journal failed:', journalError)
    }
  }

  /** Default and ceiling for the caller-supplied row limit. */
  static rowLimits(): { default: number; max: number } {
    return { default: DEFAULT_ROW_LIMIT, max: MAX_ROW_LIMIT }
  }
}
