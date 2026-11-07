import type { RuntimeId } from '../runtime-catalog.ts'
/** Audited SQL execution channel for the resident steward runtime. */
import { Query, type PoolClient } from 'pg'
import { connectFromPool } from './database.ts'
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
  runtimeId: RuntimeId
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

/**
 * Bounded administrator-facing summary of one steward query attempt. The
 * statement text and any error message stay in `steward_query_log`; the audit
 * console receives only classification, verdict, and size facts.
 */
function stewardAuditDetail(
  classification: 'read' | 'write',
  status: 'ok' | 'denied' | 'error',
  rowCount: number | null,
  bytes: number | null,
  dryRun: boolean,
  approvalId: string | undefined,
): string {
  return JSON.stringify({
    methodPath: '',
    detail: {
      classification,
      status,
      rowCount: rowCount ?? 0,
      resultBytes: bytes ?? 0,
      dryRun,
      ...(approvalId === undefined ? {} : { approvalId }),
    },
  })
}

/** Retain a bounded prefix while draining the single statement's row events. */
function boundedStatement(
  client: PoolClient,
  text: string,
  classification: 'read' | 'write',
  dryRun: boolean,
  rowLimit: number,
): Promise<{ output: StewardQueryResult; bytes: number }> {
  return new Promise((resolve, reject) => {
    // An empty values array uses the simple protocol. Extended mode rejects
    // additional statements before any can commit or leave READ ONLY mode.
    const config = { text, queryMode: 'extended' }
    const query = new Query<Record<string, unknown>>(config)
    const retained: unknown[] = []
    const capturesRows = dryRun || classification === 'read'
    let observed = 0
    let retainedBytes = 0
    let baseBytes: number | undefined
    let truncated = false
    let serializationError: unknown
    const output = (columns: string[], rowCount: number | null): StewardQueryResult => ({
      classification, dryRun, columns,
      rows: !dryRun && capturesRows ? retained : null,
      plan: dryRun ? retained : null,
      rowCount, truncated,
    })
    // A row listener without a callback prevents node-pg from accumulating
    // the entire result in QueryResult.rows, including write RETURNING rows.
    query.on('row', (row, result) => {
      observed++
      if (!capturesRows || truncated || serializationError !== undefined) return
      if (retained.length >= rowLimit) { truncated = true; return }
      try {
        baseBytes ??= Buffer.byteLength(JSON.stringify(output(result!.fields.map(field => field.name), Number.MAX_SAFE_INTEGER)), 'utf8')
        const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + (retained.length > 0 ? 1 : 0)
        if (baseBytes + retainedBytes + bytes > MAX_RESULT_BYTES) { truncated = true; return }
        retained.push(row)
        retainedBytes += bytes
      } catch (error) {
        serializationError = error
      }
    })
    query.on('error', reject)
    query.on('end', result => {
      if (serializationError !== undefined) { reject(serializationError); return }
      const value = output(result.fields.map(field => field.name), result.rowCount ?? observed)
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
      if (bytes > MAX_RESULT_BYTES) {
        reject(new StewardQueryError(413, 'steward-result-too-large', 'result metadata exceeds the result byte limit'))
      } else resolve({ output: value, bytes })
    })
    client.query(query)
  })
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
      return this.explain(subject, statement, classification, input.approvalId, input.rowLimit)
    }
    if (classification === 'write' && input.approvalId === undefined) {
      await this.journal(subject, statement, classification, false, 'denied', null, null, null, 'approval-required', input.approvalId)
      throw new StewardQueryError(403, 'steward-approval-required', 'write statements require an approved in-session interaction')
    }

    const client = await connectFromPool(this.context.pool)
    let failure: Error | null = null
    let afterRelease: (() => Promise<void>) | undefined
    try {
      await client.query(classification === 'read' ? 'BEGIN READ ONLY' : 'BEGIN')
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      let responderInternalId: string | null = null
      if (classification === 'write') {
        responderInternalId = await this.verifyApproval(client, input.approvalId!, subject.projectInternalId, subject.runtimeId)
        if (responderInternalId === null) {
          await client.query('ROLLBACK')
          afterRelease = () => this.journal(subject, statement, classification, false, 'denied', null, null, null, 'approval-invalid', input.approvalId)
          throw new StewardQueryError(403, 'steward-approval-invalid', 'the supplied approval interaction is missing, expired, spent, or unqualified')
        }
      }
      const { output, bytes } = await boundedStatement(client, statement, classification, false, input.rowLimit)
      const { rowCount } = output
      if (classification === 'write') {
        await client.query(`INSERT INTO harness.steward_query_log(
            organization_id,runtime_id,project_id,runtime_generation,statement,classification,dry_run,
            approval_interaction_id,responder_user_id,status,row_count,result_bytes)
          VALUES($1,$11,$2,$3,$4,$5,$6,$7,$8,'ok',$9,$10)`, [
          this.context.organizationId, subject.projectInternalId, subject.generation, statement,
          classification, false, input.approvalId ?? null, responderInternalId, rowCount, bytes, subject.runtimeId,
        ])
        await client.query(`INSERT INTO harness.audit_events(
            organization_id,actor_user_id,action,resource_type,source_ip,outcome,status_code,detail)
          VALUES($1,$2,'steward.query','steward',NULL,'success',NULL,$3::jsonb)`, [
          this.context.organizationId, responderInternalId,
          stewardAuditDetail(classification, 'ok', rowCount, bytes, false, input.approvalId),
        ])
        await client.query('COMMIT')
      } else {
        await client.query('COMMIT')
        afterRelease = () => this.journal(subject, statement, classification, false, 'ok', null, rowCount, bytes, null, input.approvalId)
      }
      return output
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      // Each attempt has one verdict; denied approvals are not execution errors.
      if (!(error instanceof StewardQueryError && error.code === 'steward-approval-invalid')) {
        const message = error instanceof Error ? error.message : String(error)
        afterRelease = () => this.journal(subject, statement, classification, false, 'error', null, null, null, message, input.approvalId)
      }
      failure = error instanceof Error ? error : new Error(String(error))
      throw error
    } finally {
      // Releasing with the error destroys a dead connection instead of lending it out again.
      if (failure === null) client.release()
      else client.release(failure)
      // Best-effort journals borrow from the pool after this query releases it.
      await afterRelease?.()
    }
  }

  private async explain(subject: StewardQuerySubject, statement: string, classification: 'read' | 'write', approvalId: string | undefined, rowLimit: number): Promise<StewardQueryResult> {
    const client = await connectFromPool(this.context.pool)
    let failure: Error | null = null
    let afterRelease: (() => Promise<void>) | undefined
    try {
      await client.query('BEGIN READ ONLY')
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      const { output, bytes } = await boundedStatement(client, `EXPLAIN ${statement}`, classification, true, rowLimit)
      await client.query('COMMIT')
      afterRelease = () => this.journal(subject, statement, classification, true, 'ok', null, output.rowCount, bytes, null, approvalId)
      return output
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      afterRelease = () => this.journal(subject, statement, classification, true, 'error', null, null, null, message, approvalId)
      failure = error instanceof Error ? error : new Error(String(error))
      throw error
    } finally {
      if (failure === null) client.release()
      else client.release(failure)
      await afterRelease?.()
    }
  }

  /**
   * A write needs a committed approval interaction that was raised inside a
   * conversation rooted in this steward project — an approval granted in any
   * other space does not carry over — whose responder is still an active
   * administrator holding an enabled steward qualification, recorded inside
   * the approval TTL. The advisory lock on the approval id serializes
   * concurrent writers: the second writer's follow-up
   * SELECT runs with a fresh READ COMMITTED snapshot and sees the first
   * write's committed audit row, so an `allowed-once` verdict green-lights
   * exactly one write. The outcome column stores the literal wire verdict
   * `'allowed-once'`.
   */
  private async verifyApproval(client: PoolClient, approvalId: string, projectInternalId: string, runtimeId: RuntimeId): Promise<string | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([this.context.organizationId, runtimeId, approvalId])])
    const result = await client.query<{ responder: string }>(`SELECT r.responder_user_id::text responder
      FROM harness.conversation_interaction_responses r
      JOIN harness.conversation_sessions c ON c.organization_id=r.organization_id AND c.runtime_namespace=r.runtime_namespace AND c.id=r.conversation_id
      JOIN harness.conversation_sessions root ON root.organization_id=c.organization_id AND root.runtime_namespace=c.runtime_namespace
        AND root.id=c.root_session_id AND root.project_id=$3
      JOIN harness.users u ON u.organization_id=r.organization_id AND u.id=r.responder_user_id AND u.status='active'
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        AND m.status='active' AND m.role='admin'
      JOIN harness.steward_access_policies sp ON sp.organization_id=u.organization_id AND sp.user_id=u.id
        AND sp.node_id=harness.project_node_id(r.organization_id,$3) AND sp.enabled
      WHERE r.organization_id=$1 AND r.runtime_id=$4 AND r.interaction_kind='approval' AND r.interaction_id=$2
        AND harness.project_computer_use_allowed(r.organization_id,u.id,$3)
        AND r.responded_at > now() - interval '${APPROVAL_TTL_MINUTES} minutes'
        AND r.outcome = to_jsonb('allowed-once'::text)
        AND NOT EXISTS (
          SELECT 1 FROM harness.steward_query_log l
          WHERE l.organization_id=r.organization_id AND l.runtime_namespace=r.runtime_namespace AND l.approval_interaction_id=r.interaction_id
            AND l.classification='write' AND l.dry_run=false AND l.status='ok')
      ORDER BY r.responded_at DESC LIMIT 1`,
    [this.context.organizationId, approvalId, projectInternalId, runtimeId])
    return result.rows[0]?.responder ?? null
  }

  /** Record a best-effort outcome outside the statement transaction. */
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
          organization_id,runtime_id,project_id,runtime_generation,statement,classification,dry_run,
          approval_interaction_id,responder_user_id,status,row_count,result_bytes,error)
        VALUES($1,$13,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
        this.context.organizationId, subject.projectInternalId, subject.generation, statement,
        classification, dryRun, approvalId ?? null, responderInternalId, status, rowCount, bytes, error, subject.runtimeId,
      ])
      // Mirror every journaled attempt into the administrator-facing audit log;
      // the statement itself stays in steward_query_log only.
      await this.context.pool.query(`INSERT INTO harness.audit_events(
          organization_id,actor_user_id,action,resource_type,source_ip,outcome,status_code,detail)
        VALUES($1,$2,'steward.query','steward',NULL,$3,NULL,$4::jsonb)`, [
        this.context.organizationId, responderInternalId,
        status === 'ok' ? 'success' : 'failure',
        stewardAuditDetail(classification, status, rowCount, bytes, dryRun, approvalId),
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
