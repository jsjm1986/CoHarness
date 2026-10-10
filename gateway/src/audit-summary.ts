/** Bounded, allowlisted audit metadata for the administrator console. */
import type { AuditRow } from './audit.ts'

const IDS = new Set(['id', 'targetId', 'userId', 'ownerUserId', 'projectId', 'nodeId', 'catalogId',
  'rootSessionId', 'sessionId', 'grantId', 'backupId', 'operationId', 'receiptId', 'redispatchId', 'subjectId',
  'approvalId', 'responderUserId'])
const NAMES = new Set(['username', 'model', 'provider', 'purpose'])
const COUNTS = new Set(['revision', 'generation', 'count', 'requested', 'succeeded', 'trashed', 'opCount',
  'rowCount', 'resultBytes'])
const FLAGS = new Set(['allowed', 'shared', 'enabled', 'autoReviewEligible', 'terminalEnabled', 'sshEligible',
  'desktopEligible', 'dryRun', 'truncated'])
const STATES = new Set(['active', 'disabled', 'deleted', 'pending', 'running', 'stopped', 'stopping',
  'ready', 'failed', 'verified', 'restored', 'submitted', 'ignored', 'rejected', 'dispatching', 'unknown',
  'complete', 'completed', 'partial', 'cancelled', 'success', 'failure', 'draining', 'offline', 'online',
  'ok', 'denied', 'error'])

/** Safe audit projection; request success is separate from asynchronous resource state. */
export interface AuditSummary {
  /** Recorded request result; absent HTTP status alone does not prove completion. */
  outcome: 'success' | 'failure' | 'recorded' | 'unknown'
  /** Selected identifiers, revisions, counts and policy choices; never raw detail or secrets. */
  metadata: Record<string, string | number | boolean>
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/u

/** One `{kind, id}` subject coordinate (`detail.target` or `detail.subject`). */
function subjectInto(metadata: AuditSummary['metadata'], subject: Record<string, unknown>, prefix: 'target' | 'subject'): void {
  const { kind, id } = subject
  if ((kind !== 'user' && kind !== 'project') || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return
  metadata[`${prefix}Kind`] = kind
  metadata[`${prefix}Id`] = id
}

/**
 * Project a durable audit record without exposing arbitrary request data.
 * @param row - database-owned result and serialized operation detail.
 * @returns bounded fields shared by PostgreSQL and local SQLite administrators.
 */
export function auditSummary(row: Pick<AuditRow, 'detail' | 'status' | 'outcome'>): AuditSummary {
  const outcome = row.status !== null && row.status >= 400 ? 'failure'
    : row.outcome === 'failure' ? 'failure'
      : row.outcome === 'unknown' ? 'unknown'
        : row.outcome === 'success' || row.status !== null && row.status >= 200 && row.status < 400 ? 'success' : 'recorded'
  const metadata: AuditSummary['metadata'] = {}
  let parsed: unknown
  try { parsed = JSON.parse(row.detail) } catch { return { outcome, metadata } }
  const detail = fields(parsed)
  if (detail === undefined) return { outcome, metadata }
  for (const [key, value] of Object.entries(detail)) {
    if (IDS.has(key) && (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      || typeof value === 'string' && NAME_PATTERN.test(value))) metadata[key] = value
    else if (NAMES.has(key) && typeof value === 'string' && NAME_PATTERN.test(value)) metadata[key] = value
    else if (COUNTS.has(key) && (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      || typeof value === 'string' && /^\d{1,20}$/u.test(value))) metadata[key] = value
    else if (FLAGS.has(key) && typeof value === 'boolean') metadata[key] = value
    else if ((key === 'status' || key === 'state' || key === 'classification') && typeof value === 'string'
      && (STATES.has(value) || value === 'read' || value === 'write')) metadata[key] = value
    else if (key === 'mode' && (value === 'ro' || value === 'rw')) metadata[key] = value
    else if (key === 'role' && (value === 'admin' || value === 'user' || value === 'member')) metadata[key] = value
    else if (key === 'action' && (value === 'enable' || value === 'disable' || value === 'remove' || value === 'restart' || value === 'stop')) metadata[key] = value
    else if (key === 'subjectType' && (value === 'user' || value === 'project')) metadata[key] = value
  }
  const target = fields(detail.target)
  if (target !== undefined) subjectInto(metadata, target, 'target')
  const subject = fields(detail.subject)
  if (subject !== undefined) subjectInto(metadata, subject, 'subject')
  return { outcome, metadata }
}
