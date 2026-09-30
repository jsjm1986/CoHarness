/** Bounded, allowlisted audit metadata for the administrator console. */
import type { AuditRow } from './audit.ts'

const IDS = new Set(['id', 'targetId', 'userId', 'ownerUserId', 'projectId', 'nodeId', 'catalogId',
  'rootSessionId', 'sessionId', 'grantId', 'backupId', 'operationId', 'receiptId', 'redispatchId', 'subjectId'])
const COUNTS = new Set(['revision', 'generation', 'count', 'requested', 'succeeded', 'trashed', 'opCount'])
const FLAGS = new Set(['allowed', 'shared', 'enabled', 'autoReviewEligible', 'terminalEnabled', 'sshEligible', 'desktopEligible'])
const STATES = new Set(['active', 'disabled', 'deleted', 'pending', 'running', 'stopped', 'stopping',
  'ready', 'failed', 'verified', 'restored', 'submitted', 'ignored', 'rejected', 'dispatching', 'unknown',
  'complete', 'completed', 'partial', 'cancelled', 'success', 'failure', 'draining', 'offline', 'online'])

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
      || typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/u.test(value))) metadata[key] = value
    else if (COUNTS.has(key) && (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      || typeof value === 'string' && /^\d{1,20}$/u.test(value))) metadata[key] = value
    else if (FLAGS.has(key) && typeof value === 'boolean') metadata[key] = value
    else if ((key === 'status' || key === 'state') && typeof value === 'string' && STATES.has(value)) metadata[key] = value
    else if (key === 'mode' && (value === 'ro' || value === 'rw')) metadata[key] = value
    else if (key === 'role' && (value === 'admin' || value === 'user' || value === 'member')) metadata[key] = value
    else if (key === 'action' && (value === 'enable' || value === 'disable' || value === 'remove' || value === 'restart' || value === 'stop')) metadata[key] = value
    else if (key === 'subjectType' && (value === 'user' || value === 'project')) metadata[key] = value
  }
  const target = fields(detail.target)
  if (target !== undefined && (target.kind === 'user' || target.kind === 'project')
    && typeof target.id === 'number' && Number.isSafeInteger(target.id) && target.id > 0) {
    metadata.targetKind = target.kind
    metadata.targetId = target.id
  }
  return { outcome, metadata }
}
