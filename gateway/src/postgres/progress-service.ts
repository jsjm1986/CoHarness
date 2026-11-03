import type { RuntimeId } from '../runtime-catalog.ts'
/**
 * Human-facing project progress journal. The digest sweep detects
 * shared-visible member activity in `conversation_*` (project-visible root
 * conversations only, never private or member-only rows), fires one
 * event-gated model pass per project, and stores synthesized entries in
 * `project_journal`. The domain is read-only for members through the account
 * routes; agent-facing memory is a separate runtime-owned domain that never
 * reads or writes this one.
 */
import type { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { transaction } from './database.ts'
import { internalProjectId, type PostgresRuntimeContext } from './runtime-context.ts'
import { CollaborationDeniedError } from '../collaboration.ts'
import type { GatewayModelGovernanceService } from '../services.ts'
import type { PostgresCollaborationService } from './collaboration-service.ts'
import type { GatewayModelBudget } from '../gateway-model-budget.ts'
import type { GatewayAccessMonitor } from '../access-invalidation.ts'
import { checkPostgresReadiness } from './runtime-context.ts'
import { readResponseBytes } from '../response-budget.ts'
import type { PostgresProgressUsage, ProgressModelRequest, ProgressRequestOutcome } from './progress-usage.ts'
import { lockAdministrator } from './administrator-authority.ts'

/** One journal line attributed back to its source conversation. */
export interface ProgressItem {
  readonly text: string
  readonly actor?: string
  readonly sessionId?: string
  /** Runtime of the cited source; absent only for unassigned retained history. */
  readonly runtimeId?: RuntimeId
  readonly sessionTitle?: string
  readonly seq?: number
}

/** Structured digest payload stored in `project_journal.content`. */
export interface ProgressContent {
  readonly summary?: string
  readonly sections: {
    readonly decided: readonly ProgressItem[]
    readonly done: readonly ProgressItem[]
    readonly doing: readonly ProgressItem[]
    readonly blocked: readonly ProgressItem[]
  }
}

/** One journal entry as served to the member surface. */
export interface ProgressEntry {
  readonly id: string
  readonly kind: 'current' | 'period'
  readonly periodKey?: string
  readonly content: ProgressContent
  readonly activityCount: number
  /** Coverage window of the material rows this entry digested. */
  readonly periodStart?: string
  readonly periodEnd?: string
  readonly model?: string
  readonly generatedAt: string
}

/** Live digest state exposed to the panel footer. */
export interface ProgressStatus {
  /** A resolvable model route exists and the feature switch is on. */
  readonly enabled: boolean
  /** Member-visible activity rows still undigested. */
  readonly pending: number
  /** A pass is in flight for this project. */
  readonly generating: boolean
  readonly lastRunAt?: string
  readonly lastError?: string
  /** The calling member may force a pass. */
  readonly canGenerate: boolean
}

/** Full journal page served by `GET /account/api/progress`. */
export interface ProgressPage {
  readonly enabled: boolean
  readonly current?: ProgressEntry
  readonly periods: readonly ProgressEntry[]
  readonly status: ProgressStatus
}

/** Result of a member-forced digest request. */
export interface ProgressGenerateResult {
  readonly started: boolean
  readonly reason?: 'generating' | 'unavailable'
}

/** Digest gate, bound, and model-call knobs (env-overridable via GatewayConfig). */
export interface ProgressConfig {
  readonly enabled: boolean
  /**
   * Preferred digest route as `provider/model` (HGW_PROGRESS_MODEL). When set
   * it is tried first; it must resolve to an allowed served route for the
   * project or the digest reports itself unavailable rather than silently
   * billing an unpinned model.
   */
  readonly model?: string
  /** Member-visible rows required to fire, unless a decision row is present. */
  readonly minActivity: number
  /** Minimum quiet after the newest activity before a pass fires. */
  readonly idleMs: number
  /** Minimum spacing between committed passes of one project. */
  readonly intervalMs: number
  /** Candidate-activity scan bound in days. */
  readonly materialWindowDays: number
  /** Member/decision material rows inlined into one prompt. */
  readonly maxMaterialRows: number
  /** Agent-kind rows admitted into the same prompt. */
  readonly maxAssistantRows: number
  /** Items kept per digest section after validation. */
  readonly maxItemsPerSection: number
  /** Model output bound per pass. */
  readonly maxOutputTokens: number
  /** Model request deadline. */
  readonly requestTimeoutMs: number
  /** Maximum retained model response bytes. */
  readonly maxResponseBytes: number
  /** Settled request records replayed into billing per sweep. */
  readonly usageReplayBatchSize: number
  /** Generating lease; a stale lease is recovered by the next candidate pass. */
  readonly leaseMs: number
  /** Projects digested per sweep tick. */
  readonly sweepMaxProjects: number
  /** Sweep tick spacing; a tick is two indexed reads per active project. */
  readonly sweepMs: number
}

export const DEFAULT_PROGRESS_CONFIG: ProgressConfig = {
  enabled: true,
  minActivity: 8,
  idleMs: 30 * 60_000,
  intervalMs: 4 * 60 * 60_000,
  materialWindowDays: 35,
  maxMaterialRows: 200,
  maxAssistantRows: 60,
  maxItemsPerSection: 8,
  maxOutputTokens: 4096,
  requestTimeoutMs: 120_000,
  maxResponseBytes: 1024 * 1024,
  usageReplayBatchSize: 64,
  leaseMs: 10 * 60_000,
  sweepMaxProjects: 4,
  sweepMs: 60_000,
}

/** One shared-visible material row inlined into the digest prompt. */
interface MaterialRow {
  readonly kind: 'member' | 'decision' | 'agent'
  readonly runtimeId: RuntimeId | null
  readonly runtimeNamespace: string
  readonly sessionId: string
  readonly sessionTitle: string | null
  readonly actor: string | null
  readonly occurredAt: Date
  readonly timestamp: string
  readonly micros: bigint
  readonly entryId: string
  readonly seq: number
  readonly text: string
}

interface StateRow {
  readonly watermark_ts: Date | null
  readonly watermark_session: string | null
  readonly watermark_runtime_namespace: string | null
  readonly watermark_seq: string | null
  readonly last_run_at: Date | null
  readonly generating_since: Date | null
  readonly last_error: string | null
}

interface JournalRow {
  readonly id: string
  readonly kind: 'current' | 'period'
  readonly period_key: string | null
  readonly content: ProgressContent
  readonly activity_count: number
  readonly period_start: Date | null
  readonly period_end: Date | null
  readonly model: string | null
  readonly generated_at: Date
}

/**
 * The `visible` CTE: project-visible root conversations of one project, with
 * display titles (same derivation the activity feed uses).
 */
const VISIBLE_CTE = `visible AS (
  SELECT r.organization_id,r.runtime_id,r.runtime_namespace,r.id,COALESCE(to_json(harness.human_session_title(r.title)), (SELECT harness.conversation_search_text(search.content,search.content_nul_parts,80)
    FROM harness.conversation_search search
    WHERE search.organization_id=r.organization_id AND search.runtime_namespace=r.runtime_namespace AND search.session_id=r.id AND search.role='user'
      AND harness.human_session_title(search.content) IS NOT NULL
    ORDER BY search.occurred_at,search.event_seq LIMIT 1)) title
  FROM harness.conversation_sessions r
  WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=r.root_session_id
    AND r.status<>'deleted' AND r.visibility='project'
)`

/** Count-only reads need source identities, without resolving display titles from message history. */
const VISIBLE_ROOTS_CTE = `visible AS (SELECT r.organization_id,r.runtime_id,r.runtime_namespace,r.id FROM harness.conversation_sessions r
  WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=r.root_session_id
    AND r.status<>'deleted' AND r.visibility='project')`

/** Exclude committed sources before joining and decoding their event JSON. */
const MEMBER_INPUTS = `pending_messages AS MATERIALIZED (
  SELECT s.organization_id,s.runtime_id,s.runtime_namespace,s.session_id,s.event_seq,s.content,s.content_nul_parts,s.role FROM harness.conversation_search s JOIN visible v ON v.organization_id=s.organization_id AND v.runtime_namespace=s.runtime_namespace AND v.id=s.session_id
  WHERE s.role='user' AND s.occurred_at>now()-($3::text||' days')::interval
    AND ${unconsumedSql('s.session_id', "'message:'||s.event_seq::text", 's.runtime_namespace')}
), pending_answers AS MATERIALIZED (
  SELECT c.organization_id,c.runtime_id,c.runtime_namespace,c.conversation_id,c.interaction_id,c.call_id,c.outcome,c.responder_user_id,c.responded_at,c.interaction_kind
    FROM harness.conversation_interaction_responses c JOIN visible v ON v.organization_id=c.organization_id AND v.runtime_namespace=c.runtime_namespace AND v.id=c.conversation_id
  WHERE c.interaction_kind='question' AND jsonb_typeof(c.outcome->'answers')='array'
    AND c.responded_at>now()-($3::text||' days')::interval
    AND ${unconsumedSql('c.conversation_id', "'question:'||c.interaction_id", 'c.runtime_namespace')}
)`

/** Member-authored feed rows (messages plus claimed question answers). */
const MEMBER_ROWS = `
  SELECT 'decision' kind, c.organization_id,c.runtime_id,c.runtime_namespace,c.conversation_id session_id, COALESCE(res.seq,-1) seq,
    c.responded_at ts, NULL::json text, to_json(u.display_name) actor_label,
    (call_args.query_fields->>'argumentsJson')::json question_args, c.outcome,
    'question:'||c.interaction_id entry_id
  FROM pending_answers c
  JOIN visible v ON v.organization_id=c.organization_id AND v.runtime_namespace=c.runtime_namespace AND v.id=c.conversation_id
  JOIN harness.users u ON u.id=c.responder_user_id AND u.organization_id=c.organization_id
  LEFT JOIN harness.conversation_events res ON res.organization_id=c.organization_id AND res.runtime_namespace=c.runtime_namespace AND res.session_id=c.conversation_id
    AND res.event_type='tool/result' AND res.query_fields->>'callId'=c.call_id
  LEFT JOIN harness.conversation_events call_args ON call_args.organization_id=c.organization_id AND call_args.runtime_namespace=c.runtime_namespace AND call_args.session_id=c.conversation_id
    AND call_args.event_type='tool/call' AND call_args.query_fields->>'callId'=c.call_id
  WHERE c.interaction_kind='question' AND jsonb_typeof(c.outcome->'answers')='array'
  UNION ALL
  SELECT 'member',e.organization_id,e.runtime_id,e.runtime_namespace,e.session_id,e.seq,e.occurred_at ts,
    harness.conversation_search_text(search_row.content,search_row.content_nul_parts,500) text,
    (e.query_fields->>'actorLabelJson')::json actor_label,
    NULL, NULL, 'message:'||e.seq::text
  FROM pending_messages search_row
  JOIN harness.conversation_events e ON e.organization_id=search_row.organization_id AND e.runtime_namespace=search_row.runtime_namespace AND e.session_id=search_row.session_id AND e.seq=search_row.event_seq
  JOIN visible v ON v.organization_id=e.organization_id AND v.runtime_namespace=e.runtime_namespace AND v.id=e.session_id
  WHERE search_row.role='user' AND e.query_fields->>'actorUid' IS NOT NULL`

/** Fixed-size receipt key; the zero byte separates two PostgreSQL text values that cannot contain NUL. */
const MATERIAL_RECEIPT = materialReceiptSql('f.session_id', 'f.entry_id')

/** Arrival order and timestamp rounding cannot exclude an unconsumed source row. */
const UNCONSUMED = unconsumedSql('f.session_id', 'f.entry_id', 'f.runtime_namespace')

function materialReceiptSql(session: string, entry: string): string {
  return `pg_catalog.sha256(pg_catalog.convert_to(${session},'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(${entry},'UTF8'))`
}

function unconsumedSql(session: string, entry: string, runtimeNamespace: string): string {
  return `NOT EXISTS(SELECT 1 FROM harness.project_journal_materials consumed
    WHERE consumed.organization_id=$1 AND consumed.project_id=$2 AND consumed.receipt=${materialReceiptSql(session, entry)}
      AND consumed.runtime_namespace=${runtimeNamespace} AND consumed.session_id=${session} AND consumed.entry_id=${entry})`
}

const MATERIAL_TIME = `to_char(f.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_ts,
  floor(EXTRACT(EPOCH FROM f.ts)*1000000)::text ts_us`

interface MaterialKeyRow {
  readonly runtime_id: RuntimeId | null
  readonly runtime_namespace: string
  readonly session_id: string
  readonly seq: string
  readonly ts: Date
  readonly cursor_ts: string
  readonly ts_us: string
  readonly entry_id: string
}

/** Render one material row as a numbered prompt line. */
function materialLine(index: number, row: MaterialRow): string {
  const ts = row.occurredAt.toISOString().slice(5, 16).replace('T', ' ')
  const title = row.sessionTitle ?? '(untitled conversation)'
  const actor = row.actor ?? 'agent'
  const verb = row.kind === 'decision' ? 'decided' : row.kind === 'member' ? 'said' : 'reported'
  return `[${String(index)}] ${ts} · ${actor} · ${title} · ${verb}: ${row.text}`
}

/**
 * ISO-8601 week key (`YYYY-Www`) for the instant a period covers.
 * @param date instant inside the covered week
 * @returns period key such as `2026-W43`
 */
export function periodKeyOf(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay()
  day.setUTCDate(day.getUTCDate() + 4 - weekday)
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
  const week = Math.floor((day.getTime() - yearStart.getTime()) / 604_800_000) + 1
  return `${String(day.getUTCFullYear())}-W${String(week).padStart(2, '0')}`
}

/**
 * Validate model output and resolve its `refs` row indices into source
 * attributions. Unresolvable items are dropped; an output carrying neither a
 * summary nor a single valid item rejects so the pass retries later.
 * @param raw raw model response text
 * @param material material rows the prompt numbered 1..N
 * @param maxItems per-section item cap
 * @returns stored journal payload
 */
export function resolveDigestOutput(raw: string, material: readonly MaterialRow[], maxItems: number): ProgressContent {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('digest output carried no JSON object')
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('digest output is not a JSON object')
  }
  const body = parsed as Record<string, unknown>
  const resolveRefs = (refs: unknown): MaterialRow | undefined => {
    if (!Array.isArray(refs)) return undefined
    for (const ref of refs) {
      if (Number.isSafeInteger(ref) && material[ref - 1] !== undefined) return material[ref - 1]
    }
    return undefined
  }
  const item = (value: unknown, refRequired: boolean): ProgressItem | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const row = value as Record<string, unknown>
    if (typeof row.text !== 'string' || row.text.trim() === '') return undefined
    const source = resolveRefs(row.refs)
    if (source === undefined && refRequired) return undefined
    return {
      text: row.text.trim(),
      ...(source === undefined ? {} : {
        ...(source.actor === null ? {} : { actor: source.actor }),
        sessionId: source.sessionId,
        ...(source.runtimeId === null ? {} : { runtimeId: source.runtimeId }),
        ...(source.sessionTitle === null ? {} : { sessionTitle: source.sessionTitle }),
        seq: source.seq,
      }),
    }
  }
  const section = (key: string, refRequired = true): readonly ProgressItem[] => {
    const value = body[key] ?? (body.sections as Record<string, unknown> | undefined)?.[key]
    if (!Array.isArray(value)) return []
    return value.flatMap((entry) => {
      const resolved = item(entry, refRequired)
      return resolved === undefined ? [] : [resolved]
    }).slice(0, maxItems)
  }
  const summary = typeof body.summary === 'string' && body.summary.trim() !== '' ? body.summary.trim() : undefined
  const sections = { decided: section('decided'), done: section('done'), doing: section('doing'), blocked: section('blocked', false) }
  if (summary === undefined && Object.values(sections).every(list => list.length === 0)) {
    throw new Error('digest output carried no usable summary or items')
  }
  return { ...(summary === undefined ? {} : { summary }), sections }
}

const DIGEST_INSTRUCTION = `You write the shared progress journal for the project "{project}". Project members read it to catch up without opening the chat history. This is not a conversation; address no one.

<previous_current>
{previousCurrent}
</previous_current>

<open_period period="{periodKey}">
{openPeriod}
</open_period>

<new_activity since="{since}">
{material}
</new_activity>

Produce strict JSON only — no prose, no code fences:
{
  "summary": "<2-4 sentences: where the project stands now, in the material's language>",
  "decided": [{ "text": "<what was decided>", "refs": [1] }],
  "done": [{ "text": "<what was completed>", "refs": [3] }],
  "doing": [{ "text": "<work still in motion>", "refs": [2] }],
  "blocked": [{ "text": "<open blocker or unanswered question>", "refs": [] }]
}

Rules:
- refs cite row indices from <new_activity>; every item needs at least one ref except blocked.
- Merge <open_period> with the new activity into one complete period narrative — the output REPLACES it.
- "decided" = member-chosen answers and explicit member decisions; "done" = finished agent work or confirmed completions; "doing" = work in motion; "blocked" = unresolved blockers or questions awaiting answers.
- Rewrite the rolling summary to describe the project as it stands now, not only the new slice.
- Write in the language of the material. Do not invent facts, names, or outcomes.
- At most {maxItems} items per section, most significant first.`

interface DigestEndpoint {
  readonly provider: string
  readonly model: string
  readonly baseURL: string
  readonly apiKey: string | null
  readonly credentialSource: 'organization' | 'project'
  readonly headers: Headers
  readonly maxOutputTokens: number
}

/** Billing remains replayable; a failed acknowledgement must not start another provider attempt. */
class ProgressUsageDeliveryError extends Error {}

/** Access invalidation cancels this pass without trying a different provider. */
class ProgressAccessChangedError extends Error {}

/** Administrator-visible organization digest pin and enabled catalog candidates. */
export interface ProgressDigestModelSettings {
  /** Organization override; null delegates to deployment selection. */
  model: string | null
  /** Enabled organization-owned routes accepted by the pin mutation. */
  candidates: Array<{ provider: string; model: string }>
}

/** PostgreSQL-backed project progress digest service. */
export class PostgresProgressService {
  private readonly stop = new AbortController()
  private readonly pendingTasks = new Set<Promise<unknown>>()
  private readonly passes = new Set<{ projectId: number; actorId: number; controller: AbortController }>()
  private unsubscribeAccess: (() => void) | undefined
  private closed = false

  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly deps: {
      readonly collaboration: Pick<PostgresCollaborationService, 'projectForUser'>
      readonly governance?: GatewayModelGovernanceService | undefined
      readonly budget?: Pick<GatewayModelBudget, 'run'> | undefined
      readonly usage?: Pick<PostgresProgressUsage, 'prepare' | 'complete' | 'flush'> | undefined
      readonly accessMonitor?: GatewayAccessMonitor | undefined
      /** Fresh maintenance and restored-data fence, evaluated after node admission. */
      readonly beforeDispatch?: (() => Promise<void>) | undefined
      /** Include manually started background work in maintenance quiescence. */
      readonly trackWrite?: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined
      /** Reject results produced against a database generation replaced by restore. */
      readonly assertDataEpoch?: (() => Promise<void>) | undefined
    },
    private readonly config: ProgressConfig = DEFAULT_PROGRESS_CONFIG,
  ) {
    this.unsubscribeAccess = deps.accessMonitor?.subscribe(subject => {
      for (const request of this.passes) {
        if (subject.userId !== undefined && subject.userId !== request.actorId) continue
        if (subject.projectId !== undefined && subject.projectId !== request.projectId) continue
        request.controller.abort(new ProgressAccessChangedError('Project progress access changed'))
      }
    })
  }

  private get pool(): Pool { return this.context.pool }

  /**
   * Serve the member-facing journal page: entries plus live status. Shared
   * entries are readable by every project member; `canGenerate` mirrors the
   * member's write authority.
   * @param projectId public project id
   * @param userId public user id
   * @returns journal page with status
   */
  async progressForUser(projectId: number, userId: number): Promise<ProgressPage> {
    const authority = await this.deps.collaboration.projectForUser(projectId, userId)
    if (authority === null) throw new CollaborationDeniedError('not-member')
    const internal = await internalProjectId(this.pool, this.context.organizationId, projectId)
    if (internal === null) throw new CollaborationDeniedError('not-member')
    const state = await this.stateRow(internal)
    const pending = await this.pending(internal)
    const entries = await this.entries(internal)
    const enabled = this.config.enabled && this.deps.budget !== undefined && this.deps.usage !== undefined
      && (await this.resolveEndpoints(projectId)).length > 0
    const status: ProgressStatus = {
      enabled,
      pending: pending.count,
      generating: this.generating(state),
      ...(state?.last_run_at == null ? {} : { lastRunAt: state.last_run_at.toISOString() }),
      ...(state?.last_error == null ? {} : { lastError: state.last_error }),
      canGenerate: authority.mode === 'rw' || authority.administrator,
    }
    return {
      enabled,
      current: entries.find(entry => entry.kind === 'current'),
      periods: entries.filter(entry => entry.kind === 'period'),
      status,
    }
  }

  /**
   * Force one pass on behalf of a member. Read-only members and unavailable
   * routes refuse; an in-flight lease reports `generating`. The pass runs in
   * the background — the member surface polls `progressForUser` for status.
   * @param projectId public project id
   * @param userId public user id
   * @returns whether a pass was admitted
   */
  async generateNow(projectId: number, userId: number): Promise<ProgressGenerateResult> {
    if (this.closed) return { started: false, reason: 'unavailable' }
    return this.track(this.generateNowOwned(projectId, userId))
  }

  private async generateNowOwned(projectId: number, userId: number): Promise<ProgressGenerateResult> {
    const authority = await this.deps.collaboration.projectForUser(projectId, userId)
    if (authority === null) throw new CollaborationDeniedError('not-member')
    if (authority.mode !== 'rw' && !authority.administrator) throw new CollaborationDeniedError('forbidden')
    const internal = await internalProjectId(this.pool, this.context.organizationId, projectId)
    if (internal === null) throw new CollaborationDeniedError('not-member')
    if (this.closed || !this.config.enabled || this.deps.budget === undefined || this.deps.usage === undefined
      || (await this.resolveEndpoints(projectId)).length === 0) {
      return { started: false, reason: 'unavailable' }
    }
    const lease = await this.acquire(internal)
    if (lease === null) return { started: false, reason: 'generating' }
    // runPass records last_error itself; only a failure of that recording path
    // escapes here, and it has nowhere else to land.
    void this.track(this.runPass(projectId, internal, lease, userId)).catch(error => {
      console.error('[gateway] project progress failure could not be recorded:', error)
    })
    return { started: true }
  }

  /**
   * Find projects with unconsumed shared material, apply sweep policy and run bounded passes.
   * A project with no new material does not reach the model.
   */
  async sweep(): Promise<void> {
    if (this.closed) return
    if (!this.config.enabled || this.deps.budget === undefined) return this.track(this.deps.usage?.flush() ?? Promise.resolve())
    return this.track(this.sweepOwned())
  }

  /** Stop future passes, cancel queued or running inference, and join every owned pass. */
  async close(): Promise<void> {
    this.closed = true
    this.stop.abort(new Error('Project progress is shutting down'))
    this.unsubscribeAccess?.()
    this.unsubscribeAccess = undefined
    while (this.pendingTasks.size > 0) await Promise.allSettled([...this.pendingTasks])
    await this.deps.usage?.flush()
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pendingTasks.add(task)
    void task.then(() => this.pendingTasks.delete(task), () => this.pendingTasks.delete(task))
    return task
  }

  private async sweepOwned(): Promise<void> {
    await this.deps.usage?.flush()
    const candidates = await this.candidates()
    let ran = 0
    for (const candidate of candidates) {
      if (this.closed) return
      if (ran >= this.config.sweepMaxProjects) return
      const internal = candidate.projectId
      try {
        const state = await this.stateRow(internal)
        if (this.generating(state)) continue
        const pending = await this.pending(internal)
        if (pending.count === 0) continue
        const now = Date.now()
        const quiet = pending.latest === null || now - pending.latest.getTime() >= this.config.idleMs
        const spaced = state?.last_run_at == null || now - state.last_run_at.getTime() >= this.config.intervalMs
        const enough = pending.hasDecision || pending.count >= this.config.minActivity
        if (!quiet || !spaced || !enough) continue
        const project = await this.publicIdOf(internal)
        if (project === null) continue
        const lease = await this.acquire(internal)
        if (lease === null) continue
        await this.runPass(project, internal, lease)
        ran += 1
      } catch (error) {
        // One broken project must not starve the rest of the sweep.
        console.error(`[gateway] project progress digest skipped ${internal}:`, error)
      }
    }
  }

  /** Local-computer projects with shared-visible member activity inside the scan window. */
  private async candidates(): Promise<{ projectId: string }[]> {
    const result = await this.pool.query<{ pid: string }>(`
      WITH live_projects AS (SELECT p.id FROM harness.projects p JOIN harness.organizations o ON o.id=p.organization_id
        WHERE p.organization_id=$1 AND p.status='active' AND o.status='active'
          AND harness.project_node_id(p.organization_id,p.id)=$3
          AND EXISTS(SELECT 1 FROM harness.compute_nodes n WHERE n.id=$3 AND n.organization_id=$1 AND n.status='active'))
      SELECT pid FROM (
        SELECT r.project_id::text pid
        FROM harness.conversation_search s
        JOIN harness.conversation_sessions r ON r.organization_id=s.organization_id AND r.runtime_namespace=s.runtime_namespace AND r.id=s.session_id
        JOIN live_projects p ON p.id=r.project_id
        WHERE r.organization_id=$1 AND r.id=r.root_session_id AND r.status<>'deleted'
          AND r.visibility='project' AND r.project_id IS NOT NULL AND s.role='user'
          AND s.occurred_at > now() - ($2::text || ' days')::interval
        UNION ALL
        SELECT r.project_id::text
        FROM harness.conversation_interaction_responses c
        JOIN harness.conversation_sessions r ON r.organization_id=c.organization_id AND r.runtime_namespace=c.runtime_namespace AND r.id=c.conversation_id
        JOIN live_projects p ON p.id=r.project_id
        WHERE c.organization_id=$1 AND r.id=r.root_session_id AND r.status<>'deleted' AND r.visibility='project'
          AND c.interaction_kind='question' AND jsonb_typeof(c.outcome->'answers')='array'
          AND c.responded_at > now() - ($2::text || ' days')::interval
      ) recent GROUP BY pid`,
    [this.context.organizationId, String(this.config.materialWindowDays), this.context.nodeId])
    return result.rows.map(row => ({ projectId: row.pid }))
  }

  /** Unconsumed member-visible rows inside the source window, including delayed arrivals. */
  private async pending(internal: string): Promise<{ count: number; latest: Date | null; hasDecision: boolean }> {
    const result = await this.pool.query<{ pending: number; latest: Date | null; decided: boolean }>(`
      WITH ${VISIBLE_ROOTS_CTE}, ${MEMBER_INPUTS}, feed AS (${MEMBER_ROWS})
      SELECT count(*)::int pending, max(f.ts) latest, coalesce(bool_or(f.kind='decision'),false) decided
      FROM feed f WHERE f.ts > now() - ($3::text || ' days')::interval`,
    [this.context.organizationId, internal, String(this.config.materialWindowDays)])
    const row = result.rows[0]
    return { count: Number(row?.pending ?? 0), latest: row?.latest ?? null, hasDecision: row?.decided === true }
  }

  /**
   * Unconsumed material, oldest first, plus `limit`: the last
   * key a capped stream provably covers. When either stream hit its cap the
   * merged tail past `limit` may be missing rows, so callers consume only the
   * complete prefix and retain the rest for a later pass.
   */
  private async material(internal: string): Promise<{ rows: MaterialRow[]; limit: MaterialRow | null }> {
    const parameters = [this.context.organizationId, internal, String(this.config.materialWindowDays)]
    const members = await this.pool.query<MaterialKeyRow & {
      kind: 'decision' | 'member'; session_id: string; seq: string; ts: Date
      text: string | null; actor_label: string | null; outcome: unknown; question_args: string | null
      title: string | null
    }>(`
      WITH ${VISIBLE_CTE}, ${MEMBER_INPUTS}, feed AS (${MEMBER_ROWS})
      SELECT f.*, v.title, ${MATERIAL_TIME} FROM feed f JOIN visible v ON v.organization_id=f.organization_id AND v.runtime_namespace=f.runtime_namespace AND v.id=f.session_id
      WHERE f.ts > now() - ($3::text || ' days')::interval
      ORDER BY f.ts, f.runtime_namespace COLLATE "C", f.session_id COLLATE "C", f.seq, f.entry_id COLLATE "C" LIMIT $4`,
    [...parameters, this.config.maxMaterialRows])
    const agents = await this.pool.query<MaterialKeyRow & {
      session_id: string; seq: string; ts: Date; text: string | null; title: string | null
    }>(`
      WITH ${VISIBLE_CTE}, feed AS (
        SELECT 'agent' kind, e.organization_id,e.runtime_id,e.runtime_namespace,e.session_id, e.seq, e.occurred_at ts,
          harness.conversation_search_text(search_row.content,search_row.content_nul_parts,300) text, 'message:'||e.seq::text entry_id
        FROM harness.conversation_search search_row
        JOIN harness.conversation_events e ON e.organization_id=search_row.organization_id AND e.runtime_namespace=search_row.runtime_namespace AND e.session_id=search_row.session_id AND e.seq=search_row.event_seq
        JOIN visible v ON v.organization_id=e.organization_id AND v.runtime_namespace=e.runtime_namespace AND v.id=e.session_id
        WHERE search_row.role='assistant')
      SELECT f.*, v.title, ${MATERIAL_TIME} FROM feed f JOIN visible v ON v.organization_id=f.organization_id AND v.runtime_namespace=f.runtime_namespace AND v.id=f.session_id
      WHERE ${UNCONSUMED}
        AND f.ts > now() - ($3::text || ' days')::interval
      ORDER BY f.ts, f.runtime_namespace COLLATE "C", f.session_id COLLATE "C", f.seq, f.entry_id COLLATE "C" LIMIT $4`,
    [...parameters, this.config.maxAssistantRows])
    const rows: MaterialRow[] = []
    for (const row of members.rows) {
      const text = row.kind === 'decision'
        ? `${questionText(row.question_args) ?? '(question)'} → ${answerSummary(row.outcome)}`
        : (row.text ?? '')
      rows.push({
        kind: row.kind, sessionId: row.session_id, sessionTitle: row.title,
        actor: row.actor_label, ...materialKey(row), text,
      })
    }
    for (const row of agents.rows) {
      rows.push({
        kind: 'agent', sessionId: row.session_id, sessionTitle: row.title,
        actor: null, ...materialKey(row), text: row.text ?? '',
      })
    }
    rows.sort(compareKeys)
    const lastMember = members.rows.length === this.config.maxMaterialRows ? members.rows[members.rows.length - 1] : undefined
    const lastAgent = agents.rows.length === this.config.maxAssistantRows ? agents.rows[agents.rows.length - 1] : undefined
    const limits: MaterialRow[] = []
    if (lastMember !== undefined) {
      limits.push({ kind: 'member', sessionId: lastMember.session_id, sessionTitle: null, actor: null, ...materialKey(lastMember), text: '' })
    }
    if (lastAgent !== undefined) {
      limits.push({ kind: 'agent', sessionId: lastAgent.session_id, sessionTitle: null, actor: null, ...materialKey(lastAgent), text: '' })
    }
    limits.sort(compareKeys)
    return { rows, limit: limits[0] ?? null }
  }

  /** Acquire or renew a generation only for an active project fixed to this computer. */
  private async acquire(internal: string): Promise<string | null> {
    const lease = randomUUID()
    const result = await this.pool.query(
      `INSERT INTO harness.project_journal_state(organization_id,project_id,generating_since,updated_at,generation_id)
       SELECT $1,id,now(),now(),$4 FROM harness.projects
       WHERE organization_id=$1 AND id=$2 AND status='active' AND harness.project_node_id(organization_id,id)=$5
       ON CONFLICT (project_id) DO UPDATE SET generating_since=now(),updated_at=now(),generation_id=excluded.generation_id
         WHERE harness.project_journal_state.generating_since IS NULL
            OR harness.project_journal_state.generating_since < now() - ($3::text || ' milliseconds')::interval`,
      [this.context.organizationId, internal, String(this.config.leaseMs), lease, this.context.nodeId])
    return result.rowCount === 1 ? lease : null
  }

  /**
   * Run one pass under an acquired lease: material → model → one transaction
   * covering entries, source receipts and progress position. Failures record
   * `last_error` and leave source receipts uncommitted for a later pass.
   */
  private runPass(publicId: number, internal: string, lease: string, actorId = 0): Promise<void> {
    const operation = () => this.runPassOwned(publicId, internal, lease, actorId)
    return this.deps.trackWrite === undefined ? operation() : this.deps.trackWrite(operation)
  }

  private async runPassOwned(publicId: number, internal: string, lease: string, actorId: number): Promise<void> {
    const pass = { projectId: publicId, actorId, controller: new AbortController() }
    const signal = AbortSignal.any([this.stop.signal, pass.controller.signal])
    try {
      await this.deps.accessMonitor?.synchronize()
      signal.throwIfAborted()
      this.passes.add(pass)
      const state = await this.stateRow(internal)
      const fetched = await this.material(internal)
      // A capped stream's tail may be missing rows; digest only the complete
      // prefix so no source receipt acknowledges undigested material.
      const receipts = fetched.limit === null
        ? fetched.rows
        : fetched.rows.filter(row => compareKeys(row, fetched.limit!) <= 0)
      const material = receipts.filter(row => row.text !== '')
      if (material.length === 0) {
        if (receipts.length === 0) await this.clearLease(internal, lease)
        else await transaction(this.pool, async client => {
          await this.deps.assertDataEpoch?.()
          signal.throwIfAborted()
          await this.assertVisible(client, internal, receipts)
          await this.renewLease(client, internal, lease)
          await this.recordReceipts(client, internal, receipts)
          await this.clearLease(internal, lease, client)
          signal.throwIfAborted()
        })
        return
      }
      const endpoints = await this.resolveEndpoints(publicId)
      if (endpoints.length === 0) {
        const pin = await this.digestModelPin()
        throw new Error(pin === undefined
          ? 'no resolvable model route'
          : `configured digest model ${pin} is not an allowed served route`)
      }
      const periodKey = periodKeyOf(material[material.length - 1]!.occurredAt)
      const [openPeriod, current, projectName] = await Promise.all([
        this.periodEntry(internal, periodKey), this.currentEntry(internal), this.projectName(internal),
      ])
      const values: Record<string, string> = {
        project: projectName ?? String(publicId), previousCurrent: current?.content.summary ?? '(none)', periodKey,
        openPeriod: openPeriod === undefined ? '(none)' : JSON.stringify(openPeriod.content),
        since: state?.watermark_ts?.toISOString() ?? 'the beginning',
        material: material.map((row, index) => materialLine(index + 1, row)).join('\n'),
        maxItems: String(this.config.maxItemsPerSection),
      }
      const prompt = DIGEST_INSTRUCTION.replace(/\{(project|previousCurrent|periodKey|openPeriod|since|material|maxItems)\}/g,
        (_match, key: string) => values[key]!)
      let raw: string | undefined
      let model = ''
      let failure: unknown = new Error('no resolvable model route')
      for (const endpoint of endpoints) {
        try {
          signal.throwIfAborted()
          raw = await this.callModel(publicId, internal, lease, material, actorId, endpoint, prompt, signal)
          model = `${endpoint.provider}/${endpoint.model}`
          break
        } catch (error) {
          failure = error instanceof Error ? new Error(`${endpoint.provider}: ${error.message}`) : error
          if (signal.aborted || error instanceof ProgressUsageDeliveryError) break
        }
      }
      if (raw === undefined) throw failure
      await this.deps.accessMonitor?.synchronize()
      signal.throwIfAborted()
      const content = resolveDigestOutput(raw, material, this.config.maxItemsPerSection)
      const last = material[material.length - 1]!
      const memberRows = material.filter(row => row.kind !== 'agent').length
      await transaction(this.pool, async (client) => {
        await this.deps.assertDataEpoch?.()
        signal.throwIfAborted()
        await this.assertVisible(client, internal, receipts)
        await this.renewLease(client, internal, lease)
        await client.query(`INSERT INTO harness.project_journal(
            organization_id,project_id,kind,content,activity_count,model,generated_at,created_at,updated_at)
          VALUES($1,$2,'current',$3::json,$4,$5,now(),now(),now())
          ON CONFLICT (organization_id,project_id) WHERE kind='current'
          DO UPDATE SET content=excluded.content,activity_count=excluded.activity_count,
            model=excluded.model,generated_at=excluded.generated_at,invalidated_at=NULL,updated_at=now()`,
        [this.context.organizationId, internal, JSON.stringify(content), memberRows, model])
        await client.query(`INSERT INTO harness.project_journal(
            organization_id,project_id,kind,period_key,content,activity_count,
            period_start,period_end,model,generated_at,created_at,updated_at)
          VALUES($1,$2,'period',$3,$4::json,$5,$6,$7,$8,now(),now(),now())
          ON CONFLICT (organization_id,project_id,period_key) WHERE kind='period'
          DO UPDATE SET content=excluded.content,activity_count=excluded.activity_count,
            period_end=excluded.period_end,model=excluded.model,generated_at=excluded.generated_at,invalidated_at=NULL,updated_at=now()`,
        [this.context.organizationId, internal, periodKey, JSON.stringify(content), memberRows,
          material[0]!.timestamp, last.timestamp, model])
        await this.recordReceipts(client, internal, receipts)
        await client.query(`UPDATE harness.project_journal_state
          SET (watermark_ts,watermark_runtime_namespace,watermark_session,watermark_seq)=(
            SELECT ts,namespace,sid,seq FROM (VALUES(watermark_ts,watermark_runtime_namespace,watermark_session,watermark_seq),($3::timestamptz,$7::text,$4::text,$5::bigint))
              AS keys(ts,namespace,sid,seq) ORDER BY ts DESC NULLS LAST,namespace COLLATE "C" DESC NULLS LAST,sid COLLATE "C" DESC NULLS LAST,seq DESC NULLS LAST LIMIT 1),
            last_run_at=now(),generating_since=NULL,last_error=NULL,updated_at=now()
          WHERE organization_id=$1 AND project_id=$2 AND generation_id=$6`,
        [this.context.organizationId, internal,
          last.timestamp, last.sessionId, last.seq, lease, last.runtimeNamespace])
        signal.throwIfAborted()
      })
    } catch (error: unknown) {
      await this.deps.assertDataEpoch?.()
      await this.fail(internal, lease, error instanceof Error ? error.message : String(error))
    } finally { this.passes.delete(pass) }
  }

  /**
   * Resolve the project's allowed served routes into callable endpoints in
   * catalog order. A pass tries them in sequence so one dead provider key or
   * unreachable upstream does not stall the digest.
   */
  private async resolveEndpoints(projectId: number): Promise<DigestEndpoint[]> {
    const governance = this.deps.governance
    if (governance === undefined) return []
    const policy = await governance.policyForProject(projectId)
    const endpoints: DigestEndpoint[] = []
    const seen = new Set<string>()
    for (const route of policy.models) {
      const key = JSON.stringify([route.provider, route.model])
      if (!route.allowed || seen.has(key)) continue
      seen.add(key)
      const provider = policy.providers.find(entry => entry.provider === route.provider)
      if (provider === undefined || provider.protocol !== 'openai-completions') continue
      const model = provider.models.find(entry => entry.id === route.model)
      if (model === undefined) continue
      const apiKey = provider.credentialRef === undefined || governance.resolveManagedCredential === undefined
        ? null
        : await governance.resolveManagedCredential({ kind: 'project', id: projectId }, provider.credentialRef)
      endpoints.push({ provider: route.provider, model: route.model, baseURL: provider.baseURL, apiKey,
        credentialSource: provider.scope === 'project' || provider.credentialRef?.startsWith('DSH_PROJECT_') === true ? 'project' : 'organization',
        headers: configuredHeaders(provider.profile?.headers),
        maxOutputTokens: Math.min(this.config.maxOutputTokens, model.maxTokens ?? this.config.maxOutputTokens) })
    }
    if (endpoints.length === 0) return endpoints
    const pin = await this.digestModelPin()
    if (pin !== undefined) {
      const preferred = endpoints.findIndex(
        endpoint => `${endpoint.provider}/${endpoint.model}` === pin)
      if (preferred < 0) return []
      endpoints.unshift(...endpoints.splice(preferred, 1))
    }
    return endpoints
  }

  /**
   * Effective digest route pin: the organization setting when an
   * administrator selected one, else the deployment's HGW_PROGRESS_MODEL.
   */
  private async digestModelPin(): Promise<string | undefined> {
    const row = await this.pool.query<{ digest_model: string | null }>(
      `SELECT digest_model FROM harness.organizations WHERE id=$1`, [this.context.organizationId])
    return row.rows[0]?.digest_model ?? this.config.model
  }

  /**
   * Administrator-facing digest route setting plus the enabled
   * openai-completions candidates the selector may offer.
   * @param actorUserId - authenticated public administrator id, retained through the read.
   * @returns current pin and candidate routes in `provider/model` form
   */
  async digestModelSettings(actorUserId: number): Promise<ProgressDigestModelSettings> {
    return transaction(this.pool, async client => {
      await lockAdministrator(client, this.context, actorUserId)
      return this.readDigestModelSettings(client)
    })
  }

  /** Read the catalog under the caller's retained administrator transaction. */
  private async readDigestModelSettings(client: PoolClient): Promise<ProgressDigestModelSettings> {
    const [setting, candidates] = await Promise.all([
      client.query<{ digest_model: string | null }>(
        `SELECT digest_model FROM harness.organizations WHERE id=$1`, [this.context.organizationId]),
      client.query<{ provider_key: string; model_key: string }>(
        `SELECT c.provider_key, c.model_key FROM harness.model_catalog c
         JOIN harness.model_providers p
           ON p.organization_id=c.organization_id AND p.provider_key=c.provider_key
         WHERE c.organization_id=$1 AND c.enabled AND p.status='enabled' AND p.protocol='openai-completions'
         ORDER BY c.provider_key, c.model_key`, [this.context.organizationId]),
    ])
    return {
      model: setting.rows[0]!.digest_model,
      candidates: candidates.rows.map(row => ({ provider: row.provider_key, model: row.model_key })),
    }
  }

  /**
   * Store or clear the organization digest route pin. The value must name an
   * enabled organization-owned openai-completions candidate retained through commit.
   * @param model - exact catalog `provider/model`, or `null` to clear the organization pin.
   * @param actorUserId - authenticated public administrator id, retained through commit.
   * @returns accepted setting and catalog view from the same transaction.
   */
  async setDigestModel(model: string | null, actorUserId: number): Promise<ProgressDigestModelSettings> {
    return transaction(this.pool, async client => {
      // Serialize organization writers before retaining the administrator's share locks.
      await client.query('SELECT id FROM harness.organizations WHERE id=$1 FOR NO KEY UPDATE', [this.context.organizationId])
      await lockAdministrator(client, this.context, actorUserId)
      if (model !== null) {
        const found = await client.query(
          `SELECT 1 FROM harness.model_catalog c
           JOIN harness.model_providers p
             ON p.organization_id=c.organization_id AND p.provider_key=c.provider_key
           WHERE c.organization_id=$1 AND c.enabled AND p.status='enabled' AND p.protocol='openai-completions'
             AND c.provider_key || '/' || c.model_key = $2 FOR SHARE OF c,p`,
          [this.context.organizationId, model])
        if (found.rowCount === 0) throw new Error('digest-model-unavailable')
      }
      await client.query(
        `UPDATE harness.organizations SET digest_model=$2, updated_at=now() WHERE id=$1`,
        [this.context.organizationId, model])
      return this.readDigestModelSettings(client)
    })
  }

  /** One non-streaming OpenAI-completions request bounded by the request timeout. */
  private async callModel(projectId: number, internal: string, lease: string, material: readonly MaterialRow[],
    actorId: number, previous: DigestEndpoint, prompt: string, callerSignal: AbortSignal): Promise<string> {
    const budget = this.deps.budget
    const usageJournal = this.deps.usage
    if (budget === undefined || usageJournal === undefined) throw new Error('Project progress requires node admission and durable usage')
    return budget.run({ projectId, actorId, signal: callerSignal }, async (admissionSignal, operationId) => {
      await this.deps.accessMonitor?.synchronize()
      admissionSignal.throwIfAborted()
      await this.deps.beforeDispatch?.()
      await checkPostgresReadiness(this.context, admissionSignal)
      const active = await this.pool.query(`SELECT 1 FROM harness.projects WHERE organization_id=$1 AND public_id=$2 AND status='active' AND harness.project_node_id(organization_id,id)=$3 AND harness.project_node_id(organization_id,id)=$3`,
        [this.context.organizationId, projectId, this.context.nodeId])
      if (active.rowCount !== 1) throw new Error('Project is no longer active')
      await this.renewLease(this.pool, internal, lease)
      await this.assertVisible(this.pool, internal, material)
      if (actorId !== 0) {
        const authority = await this.deps.collaboration.projectForUser(projectId, actorId)
        if (authority === null || (authority.mode !== 'rw' && !authority.administrator)) throw new CollaborationDeniedError('forbidden')
      }
      const endpoint = (await this.resolveEndpoints(projectId)).find(endpoint => endpoint.provider === previous.provider && endpoint.model === previous.model)
      if (endpoint === undefined) throw new Error('Digest model route is no longer allowed')
      admissionSignal.throwIfAborted()
      const request: ProgressModelRequest = { model: endpoint.model, messages: [{ role: 'user', content: prompt }],
        max_tokens: endpoint.maxOutputTokens, temperature: 0.2, stream: false }
      const id = await usageJournal.prepare({ projectId, internalProjectId: internal, actorId, operationId,
        provider: endpoint.provider, credentialSource: endpoint.credentialSource, request })
      const signal = AbortSignal.any([admissionSignal, AbortSignal.timeout(this.config.requestTimeoutMs)])
      let status: ProgressRequestOutcome['status'] = 'failed', usage: ProgressRequestOutcome['usage'], response: string | undefined
      let failed: unknown
      try {
        signal.throwIfAborted()
        const headers = new Headers(endpoint.headers)
        headers.set('content-type', 'application/json')
        if (endpoint.apiKey !== null) headers.set('authorization', `Bearer ${endpoint.apiKey}`)
        for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
        const reply = await fetch(`${endpoint.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', headers,
          body: JSON.stringify(request), signal,
        })
        response = new TextDecoder().decode(await readResponseBytes(reply, this.config.maxResponseBytes))
        if (!reply.ok) throw new Error(`digest model request failed: ${String(reply.status)}`)
        const body: unknown = JSON.parse(response)
        const record = objectValue(body)
        usage = modelUsage(record?.usage)
        const choice = Array.isArray(record?.choices) ? objectValue(record.choices[0]) : undefined
        const content = objectValue(choice?.message)?.content
        if (typeof content !== 'string' || content === '') throw new Error('digest model returned no content')
        status = usage === undefined ? 'missing-usage' : 'succeeded'
        return content
      } catch (error) {
        failed = error
        if (signal.aborted) status = 'cancelled'
        if (admissionSignal.reason instanceof ProgressAccessChangedError) {
          throw new ProgressAccessChangedError('Project progress access changed', { cause: error })
        }
        throw error
      } finally {
        try {
          await usageJournal.complete(id, { status, ...(usage === undefined ? {} : { usage }),
            ...(response === undefined ? {} : { response }) })
          await usageJournal.flush(id)
        } catch (error) {
          throw new ProgressUsageDeliveryError('Digest usage remains pending delivery', {
            cause: failed === undefined ? error : new AggregateError([failed, error], 'Model request and usage delivery failed'),
          })
        }
      }
    })
  }

  /** Read the per-project digest state row, if any. */
  private async stateRow(internal: string): Promise<StateRow | undefined> {
    const result = await this.pool.query<StateRow>(`SELECT watermark_ts,watermark_runtime_namespace,watermark_session,watermark_seq,
      last_run_at,generating_since,last_error FROM harness.project_journal_state
      WHERE organization_id=$1 AND project_id=$2`, [this.context.organizationId, internal])
    return result.rows[0]
  }

  /** Whether the state's lease is still live. */
  private generating(state: StateRow | undefined): boolean {
    if (state?.generating_since == null) return false
    return Date.now() - state.generating_since.getTime() < this.config.leaseMs
  }

  /** Journal rows of one project: current first, then periods newest-first. */
  private async entries(internal: string): Promise<ProgressEntry[]> {
    const result = await this.pool.query<JournalRow>(`SELECT id,kind,period_key,content,activity_count,
      period_start,period_end,model,generated_at FROM harness.project_journal
      WHERE organization_id=$1 AND project_id=$2 AND invalidated_at IS NULL
      ORDER BY CASE kind WHEN 'current' THEN 0 ELSE 1 END, period_key DESC LIMIT 26`,
    [this.context.organizationId, internal])
    return result.rows.map(row => ({
      id: row.id,
      kind: row.kind,
      ...(row.period_key === null ? {} : { periodKey: row.period_key }),
      content: row.content,
      activityCount: row.activity_count,
      ...(row.period_start === null ? {} : { periodStart: row.period_start.toISOString() }),
      ...(row.period_end === null ? {} : { periodEnd: row.period_end.toISOString() }),
      ...(row.model === null ? {} : { model: row.model }),
      generatedAt: row.generated_at.toISOString(),
    }))
  }

  /** The period entry currently open for `periodKey`, if any. */
  private async periodEntry(internal: string, periodKey: string): Promise<JournalRow | undefined> {
    const result = await this.pool.query<JournalRow>(`SELECT id,kind,period_key,content,activity_count,
      period_start,period_end,model,generated_at FROM harness.project_journal
      WHERE organization_id=$1 AND project_id=$2 AND invalidated_at IS NULL AND kind='period' AND period_key=$3`,
    [this.context.organizationId, internal, periodKey])
    return result.rows[0]
  }

  /** The rolling current entry, if any. */
  private async currentEntry(internal: string): Promise<JournalRow | undefined> {
    const result = await this.pool.query<JournalRow>(`SELECT id,kind,period_key,content,activity_count,
      period_start,period_end,model,generated_at FROM harness.project_journal
      WHERE organization_id=$1 AND project_id=$2 AND invalidated_at IS NULL AND kind='current'`,
    [this.context.organizationId, internal])
    return result.rows[0]
  }

  private async publicIdOf(internal: string): Promise<number | null> {
    const result = await this.pool.query<{ public_id: string }>(
      'SELECT public_id::text FROM harness.projects WHERE organization_id=$1 AND id=$2 AND harness.project_node_id(organization_id,id)=$3',
      [this.context.organizationId, internal, this.context.nodeId])
    const value = result.rows[0]?.public_id
    return value === undefined ? null : Number(value)
  }

  private async projectName(internal: string): Promise<string | undefined> {
    const result = await this.pool.query<{ name: string }>(
      'SELECT name FROM harness.projects WHERE organization_id=$1 AND id=$2',
      [this.context.organizationId, internal])
    return result.rows[0]?.name
  }

  private async clearLease(internal: string, lease: string, client: Pick<Pool, 'query'> = this.pool): Promise<void> {
    await client.query(`UPDATE harness.project_journal_state
      SET generating_since=NULL,last_error=NULL,updated_at=now() WHERE organization_id=$1 AND project_id=$2 AND generation_id=$3`,
    [this.context.organizationId, internal, lease])
  }

  /**
   * Record a pass failure and release the lease so a later sweep retries. The
   * failed attempt still stamps `last_run_at`, so the interval gate backs off
   * repeated failures instead of retrying on every sweep tick.
   */
  private async fail(internal: string, lease: string, message: string): Promise<void> {
    await this.pool.query(`UPDATE harness.project_journal_state
      SET generating_since=NULL,last_error=$3,last_run_at=now(),updated_at=now()
      WHERE organization_id=$1 AND project_id=$2 AND generation_id=$4`,
    [this.context.organizationId, internal, message.slice(0, 500), lease])
  }

  /** Retain or lock the exact digest generation before dispatch and before publishing either journal entry. */
  private async renewLease(client: Pick<Pool, 'query'>, internal: string, lease: string): Promise<void> {
    const result = await client.query(`UPDATE harness.project_journal_state SET generating_since=now(),updated_at=now()
      WHERE organization_id=$1 AND project_id=$2 AND generation_id=$3 RETURNING project_id`,
    [this.context.organizationId, internal, lease])
    if (result.rowCount !== 1) throw new Error('Project progress generation was superseded')
  }

  /** Recheck shared source visibility after admission and lock it through the journal transaction. */
  private async assertVisible(client: Pick<Pool, 'query'>, internal: string, material: readonly MaterialRow[]): Promise<void> {
    const identities = [...new Map(material.map(row => [JSON.stringify([row.runtimeNamespace, row.sessionId]), row])).values()]
    const result = await client.query(`SELECT source.id FROM
      unnest($3::text[],$4::text[]) selected(runtime_namespace,session_id)
      JOIN harness.conversation_sessions source ON source.organization_id=$1 AND source.project_id=$2
        AND source.runtime_namespace=selected.runtime_namespace AND source.id=selected.session_id
      WHERE source.id=source.root_session_id AND source.status<>'deleted' AND source.visibility='project'
        AND EXISTS(SELECT 1 FROM harness.projects p JOIN harness.organizations o ON o.id=p.organization_id
          WHERE p.id=$2 AND p.organization_id=$1 AND p.status='active' AND o.status='active'
            AND harness.project_node_id(p.organization_id,p.id)=$5)
      ORDER BY source.runtime_namespace COLLATE "C",source.id COLLATE "C" FOR SHARE OF source`,
    [this.context.organizationId, internal, identities.map(row => row.runtimeNamespace), identities.map(row => row.sessionId), this.context.nodeId])
    if (result.rows.length !== identities.length) throw new Error('Project progress material is no longer shared')
  }

  /** Commit exact source identities with the publication that consumed them. */
  private async recordReceipts(client: Pick<Pool, 'query'>, internal: string, material: readonly MaterialRow[]): Promise<void> {
    if (material.length === 0) return
    await client.query(`INSERT INTO harness.project_journal_materials(organization_id,project_id,runtime_id,session_id,entry_id,receipt)
      SELECT $1,$2,f.runtime_id,f.session_id,f.entry_id,${MATERIAL_RECEIPT}
      FROM unnest($3::text[],$4::text[],$5::uuid[]) AS f(session_id,entry_id,runtime_id) ON CONFLICT DO NOTHING`,
    [this.context.organizationId, internal, material.map(row => row.sessionId), material.map(row => row.entryId), material.map(row => row.runtimeId)])
  }
}

/** Selected labels and custom text of a claimed answer, bounded to one line. */
function answerSummary(outcome: unknown): string {
  const answers = (outcome as { answers?: unknown } | null)?.answers
  if (!Array.isArray(answers)) return ''
  return answers.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return ''
    const item = entry as { selected?: unknown; custom?: unknown }
    const selected = Array.isArray(item.selected)
      ? item.selected.filter((label): label is string => typeof label === 'string').join('、')
      : ''
    return [selected, typeof item.custom === 'string' ? item.custom : '']
      .filter(text => text !== '').join('：')
  }).filter(text => text !== '').join('；').slice(0, 300)
}

/** Match PostgreSQL microsecond, bytewise Session, sequence and individual-entry ordering. */
function compareKeys(left: MaterialRow, right: MaterialRow): number {
  return (left.micros < right.micros ? -1 : left.micros > right.micros ? 1 : 0)
    || Buffer.compare(Buffer.from(left.runtimeNamespace), Buffer.from(right.runtimeNamespace))
    || Buffer.compare(Buffer.from(left.sessionId), Buffer.from(right.sessionId))
    || left.seq - right.seq
    || Buffer.compare(Buffer.from(left.entryId), Buffer.from(right.entryId))
}

function materialKey(row: MaterialKeyRow): Pick<MaterialRow, 'runtimeId' | 'runtimeNamespace' | 'occurredAt' | 'timestamp' | 'micros' | 'entryId' | 'seq'> {
  const seq = Number(row.seq)
  if (!Number.isSafeInteger(seq) || seq < -1) throw new Error('Progress material has an unsupported event sequence')
  return { runtimeId: row.runtime_id, runtimeNamespace: row.runtime_namespace, occurredAt: row.ts, timestamp: row.cursor_ts, micros: BigInt(row.ts_us), entryId: row.entry_id, seq }
}

/** Asked question texts from a serialized `tool/call` arguments payload. */
function questionText(raw: string | null): string | undefined {
  if (raw === null) return undefined
  try {
    const questions = (JSON.parse(raw) as { questions?: unknown }).questions
    if (!Array.isArray(questions)) return undefined
    const text = questions
      .map(entry => (entry as { question?: unknown }).question)
      .filter((question): question is string => typeof question === 'string' && question !== '')
      .join('；').slice(0, 300)
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** OpenAI-compatible prompt counts include cache reads; billing stores disjoint token buckets. */
function modelUsage(value: unknown): ProgressRequestOutcome['usage'] {
  const usage = objectValue(value)
  const input = usage?.prompt_tokens, output = usage?.completion_tokens
  const cached = usage?.prompt_cache_hit_tokens ?? objectValue(usage?.prompt_tokens_details)?.cached_tokens ?? 0
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0
    || typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0
    || typeof cached !== 'number' || !Number.isSafeInteger(cached) || cached < 0 || cached > input
    || !Number.isSafeInteger(input + output)) return undefined
  return { inputTokens: input - cached, outputTokens: output, cacheReadTokens: cached }
}

/** Validate durable profile headers before a route can dispatch. */
function configuredHeaders(value: unknown): Headers {
  const headers = new Headers()
  if (value === undefined) return headers
  const record = objectValue(value)
  if (record === undefined) throw new Error('Digest provider headers must be a string map')
  for (const [name, content] of Object.entries(record)) {
    if (typeof content !== 'string') throw new Error('Digest provider header values must be strings')
    try { headers.set(name, content) } catch {
      throw new Error('Digest provider headers are not valid for HTTP')
    }
  }
  return headers
}
