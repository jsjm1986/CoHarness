/**
 * Human-facing project progress journal. The digest sweep detects
 * shared-visible member activity in `conversation_*` (project-visible root
 * conversations only, never private or member-only rows), fires one
 * event-gated model pass per project, and stores synthesized entries in
 * `project_journal`. The domain is read-only for members through the account
 * routes; agent-facing memory is a separate runtime-owned domain that never
 * reads or writes this one.
 */
import type { Pool } from 'pg'
import { transaction } from './database.ts'
import { internalProjectId, type PostgresRuntimeContext } from './runtime-context.ts'
import { defaultModelFromPolicy } from '../apply-model-governance.ts'
import { CollaborationDeniedError } from '../collaboration.ts'
import type { GatewayModelGovernanceService } from '../services.ts'
import type { PostgresCollaborationService } from './collaboration-service.ts'

/** One journal line attributed back to its source conversation. */
export interface ProgressItem {
  readonly text: string
  readonly actor?: string
  readonly sessionId?: string
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
  leaseMs: 10 * 60_000,
  sweepMaxProjects: 4,
  sweepMs: 60_000,
}

/** One shared-visible material row inlined into the digest prompt. */
interface MaterialRow {
  readonly kind: 'member' | 'decision' | 'agent'
  readonly sessionId: string
  readonly sessionTitle: string | null
  readonly actor: string | null
  readonly occurredAt: Date
  readonly seq: number
  readonly text: string
}

interface StateRow {
  readonly watermark_ts: Date | null
  readonly watermark_session: string | null
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
  SELECT r.id,COALESCE(harness.human_session_title(r.title), (SELECT left(search.content, 80)
    FROM harness.conversation_search search
    WHERE search.session_id=r.id AND search.role='user'
      AND harness.human_session_title(search.content) IS NOT NULL
    ORDER BY search.occurred_at,search.event_seq LIMIT 1)) title
  FROM harness.conversation_sessions r
  WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=r.root_session_id
    AND r.status<>'deleted' AND r.visibility='project'
)`

/**
 * Event JSON containing a `\u0000` escape crashes `json` navigation (`->`/`->>`)
 * when the parser de-escapes string tokens. The CASE guard skips those events —
 * the same skip-then-navigate approach the history index uses.
 */
const SAFE_EVENT = (alias: string) =>
  `(CASE WHEN position('\\u0000' in ${alias}.event::text) = 0 THEN ${alias}.event END)`

/** Member-authored feed rows (messages plus claimed question answers). */
const MEMBER_ROWS = `
  SELECT 'decision' kind, c.conversation_id session_id, COALESCE(res.seq,-1) seq,
    c.responded_at ts, NULL::text text, u.display_name actor_label,
    ${SAFE_EVENT('call_args')}->'data'->>'arguments' question_args, c.outcome
  FROM harness.conversation_interaction_responses c
  JOIN visible v ON v.id=c.conversation_id
  JOIN harness.users u ON u.id=c.responder_user_id AND u.organization_id=c.organization_id
  LEFT JOIN harness.conversation_events res ON res.session_id=c.conversation_id
    AND res.event_type='tool/result' AND ${SAFE_EVENT('res')}->'data'->>'callId'=c.call_id
  LEFT JOIN harness.conversation_events call_args ON call_args.session_id=c.conversation_id
    AND call_args.event_type='tool/call' AND ${SAFE_EVENT('call_args')}->'data'->>'callId'=c.call_id
  WHERE c.interaction_kind='question' AND jsonb_typeof(c.outcome->'answers')='array'
  UNION ALL
  SELECT 'member',e.session_id,e.seq,e.occurred_at ts,
    left(search_row.content,500) text,
    COALESCE(NULLIF(${SAFE_EVENT('e')}->'data'->'source'->'participant'->>'displayName',''),
      ${SAFE_EVENT('e')}->'data'->'source'->'participant'->>'username') actor_label,
    NULL, NULL
  FROM harness.conversation_search search_row
  JOIN harness.conversation_events e ON e.session_id=search_row.session_id AND e.seq=search_row.event_seq
  JOIN visible v ON v.id=e.session_id
  WHERE search_row.role='user' AND ${SAFE_EVENT('e')}->'data'->'source'->'participant' IS NOT NULL`

/** Watermark keyset filter shared by the pending and material queries. */
const AFTER_WATERMARK =
  `($3::timestamptz IS NULL OR (f.ts,f.session_id,f.seq) > ($3,$4::text,$5::bigint))`

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
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
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
}

/** PostgreSQL-backed project progress digest service. */
export class PostgresProgressService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly deps: {
      readonly collaboration: Pick<PostgresCollaborationService, 'projectForUser'>
      readonly governance?: GatewayModelGovernanceService | undefined
    },
    private readonly config: ProgressConfig = DEFAULT_PROGRESS_CONFIG,
  ) {}

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
    const pending = await this.pending(internal, state)
    const entries = await this.entries(internal)
    const enabled = this.config.enabled && (await this.resolveEndpoint(projectId)) !== undefined
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
    const authority = await this.deps.collaboration.projectForUser(projectId, userId)
    if (authority === null) throw new CollaborationDeniedError('not-member')
    if (authority.mode !== 'rw' && !authority.administrator) throw new CollaborationDeniedError('forbidden')
    const internal = await internalProjectId(this.pool, this.context.organizationId, projectId)
    if (internal === null) throw new CollaborationDeniedError('not-member')
    if (!this.config.enabled || (await this.resolveEndpoint(projectId)) === undefined) {
      return { started: false, reason: 'unavailable' }
    }
    if (!(await this.acquire(internal))) return { started: false, reason: 'generating' }
    // runPass records last_error itself; only a failure of that recording path
    // escapes here, and it has nowhere else to land.
    void this.runPass(projectId, internal).catch(() => undefined)
    return { started: true }
  }

  /**
   * One sweep tick: find projects whose shared-visible member activity advanced
   * past their watermark, apply the gates, and run bounded passes. Idle
   * projects cost two indexed reads; a project with no new activity never
   * reaches the model.
   */
  async sweep(): Promise<void> {
    if (!this.config.enabled) return
    const candidates = await this.candidates()
    let ran = 0
    for (const candidate of candidates) {
      if (ran >= this.config.sweepMaxProjects) return
      const internal = candidate.projectId
      const state = await this.stateRow(internal)
      if (this.generating(state)) continue
      // Equality cannot skip: rows sharing the watermark timestamp but sorted
      // past its (session, seq) key are still undigested — pending() decides.
      if (state?.watermark_ts != null && candidate.latest < state.watermark_ts) continue
      const pending = await this.pending(internal, state)
      if (pending.count === 0) continue
      const now = Date.now()
      const quiet = pending.latest === null || now - pending.latest.getTime() >= this.config.idleMs
      const spaced = state?.last_run_at == null || now - state.last_run_at.getTime() >= this.config.intervalMs
      const enough = pending.hasDecision || pending.count >= this.config.minActivity
      if (!quiet || !spaced || !enough) continue
      const project = await this.publicIdOf(internal)
      if (project === null) continue
      if (!(await this.acquire(internal))) continue
      await this.runPass(project, internal)
      ran += 1
    }
  }

  /** Projects with shared-visible member activity inside the scan window. */
  private async candidates(): Promise<{ projectId: string; latest: Date }[]> {
    const result = await this.pool.query<{ pid: string; mx: Date }>(`
      SELECT pid, MAX(mx) mx FROM (
        SELECT r.project_id::text pid, s.occurred_at mx
        FROM harness.conversation_search s
        JOIN harness.conversation_sessions r ON r.id=s.session_id
        WHERE r.organization_id=$1 AND r.id=r.root_session_id AND r.status<>'deleted'
          AND r.visibility='project' AND r.project_id IS NOT NULL AND s.role='user'
          AND s.occurred_at > now() - ($2::text || ' days')::interval
        UNION ALL
        SELECT r.project_id::text, c.responded_at
        FROM harness.conversation_interaction_responses c
        JOIN harness.conversation_sessions r ON r.id=c.conversation_id
        WHERE c.organization_id=$1 AND r.status<>'deleted' AND r.visibility='project'
          AND c.interaction_kind='question' AND jsonb_typeof(c.outcome->'answers')='array'
          AND c.responded_at > now() - ($2::text || ' days')::interval
      ) recent GROUP BY pid`,
    [this.context.organizationId, String(this.config.materialWindowDays)])
    return result.rows.map(row => ({ projectId: row.pid, latest: row.mx }))
  }

  /** Undigested member-visible rows since the stored watermark. */
  private async pending(internal: string, state: StateRow | undefined): Promise<{ count: number; latest: Date | null; hasDecision: boolean }> {
    const result = await this.pool.query<{ pending: number; latest: Date | null; decided: boolean }>(`
      WITH ${VISIBLE_CTE}, feed AS (${MEMBER_ROWS})
      SELECT count(*)::int pending, max(f.ts) latest, coalesce(bool_or(f.kind='decision'),false) decided
      FROM feed f WHERE ${AFTER_WATERMARK}`,
    [this.context.organizationId, internal,
      state?.watermark_ts?.toISOString() ?? null, state?.watermark_session ?? null, state?.watermark_seq ?? 0])
    const row = result.rows[0]
    return { count: Number(row?.pending ?? 0), latest: row?.latest ?? null, hasDecision: row?.decided === true }
  }

  /**
   * Material rows since the watermark, oldest first. Member and agent rows are
   * fetched under separate caps then merged by the watermark keyset so agent
   * volume cannot starve member-authored material.
   */
  private async material(internal: string, state: StateRow | undefined): Promise<MaterialRow[]> {
    const watermark = [this.context.organizationId, internal,
      state?.watermark_ts?.toISOString() ?? null, state?.watermark_session ?? null, state?.watermark_seq ?? 0]
    const members = await this.pool.query<{
      kind: 'decision' | 'member'; session_id: string; seq: string; ts: Date
      text: string | null; actor_label: string | null; outcome: unknown; question_args: string | null
      title: string | null
    }>(`
      WITH ${VISIBLE_CTE}, feed AS (${MEMBER_ROWS})
      SELECT f.*, v.title FROM feed f JOIN visible v ON v.id=f.session_id
      WHERE ${AFTER_WATERMARK}
      ORDER BY f.ts, f.session_id, f.seq LIMIT $6`, [...watermark, this.config.maxMaterialRows])
    const agents = await this.pool.query<{
      session_id: string; seq: string; ts: Date; text: string | null; title: string | null
    }>(`
      WITH ${VISIBLE_CTE}, feed AS (
        SELECT 'agent' kind, e.session_id, e.seq, e.occurred_at ts,
          left(search_row.content,300) text
        FROM harness.conversation_search search_row
        JOIN harness.conversation_events e ON e.session_id=search_row.session_id AND e.seq=search_row.event_seq
        JOIN visible v ON v.id=e.session_id
        WHERE search_row.role='assistant')
      SELECT f.*, v.title FROM feed f JOIN visible v ON v.id=f.session_id
      WHERE ${AFTER_WATERMARK}
      ORDER BY f.ts, f.session_id, f.seq LIMIT $6`, [...watermark, this.config.maxAssistantRows])
    const rows: MaterialRow[] = []
    for (const row of members.rows) {
      const text = row.kind === 'decision'
        ? `${questionText(row.question_args) ?? '(question)'} → ${answerSummary(row.outcome)}`
        : (row.text ?? '')
      if (text === '') continue
      rows.push({
        kind: row.kind, sessionId: row.session_id, sessionTitle: row.title,
        actor: row.actor_label, occurredAt: row.ts, seq: Number(row.seq), text,
      })
    }
    for (const row of agents.rows) {
      if (row.text === null || row.text === '') continue
      rows.push({
        kind: 'agent', sessionId: row.session_id, sessionTitle: row.title,
        actor: null, occurredAt: row.ts, seq: Number(row.seq), text: row.text,
      })
    }
    rows.sort((left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime()
      || left.sessionId.localeCompare(right.sessionId)
      || left.seq - right.seq)
    return rows
  }

  /** Acquire or renew the in-flight lease for one project. */
  private async acquire(internal: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO harness.project_journal_state(organization_id,project_id,generating_since,updated_at)
       VALUES($1,$2,now(),now())
       ON CONFLICT (project_id) DO UPDATE SET generating_since=now(),updated_at=now()
         WHERE harness.project_journal_state.generating_since IS NULL
            OR harness.project_journal_state.generating_since < now() - ($3::text || ' milliseconds')::interval`,
      [this.context.organizationId, internal, String(this.config.leaseMs)])
    return result.rowCount === 1
  }

  /**
   * Run one pass under an acquired lease: material → model → one transaction
   * covering both entries plus the watermark. Failures record `last_error` and
   * leave the watermark untouched so the same material rejoins the next pass.
   */
  private async runPass(publicId: number, internal: string): Promise<void> {
    try {
      const state = await this.stateRow(internal)
      const material = await this.material(internal, state)
      if (material.length === 0) {
        await this.clearLease(internal)
        return
      }
      const endpoint = await this.resolveEndpoint(publicId)
      if (endpoint === undefined) throw new Error('no resolvable model route')
      const periodKey = periodKeyOf(material[material.length - 1]!.occurredAt)
      const [openPeriod, current, projectName] = await Promise.all([
        this.periodEntry(internal, periodKey), this.currentEntry(internal), this.projectName(internal),
      ])
      const prompt = DIGEST_INSTRUCTION
        .replace('{project}', projectName ?? String(publicId))
        .replace('{previousCurrent}', current?.content.summary ?? '(none)')
        .replace('{periodKey}', periodKey)
        .replace('{openPeriod}', openPeriod === undefined ? '(none)' : JSON.stringify(openPeriod.content))
        .replace('{since}', state?.watermark_ts?.toISOString() ?? 'the beginning')
        .replace('{material}', material.map((row, index) => materialLine(index + 1, row)).join('\n'))
        .replace('{maxItems}', String(this.config.maxItemsPerSection))
      const raw = await this.callModel(endpoint, prompt)
      const content = resolveDigestOutput(raw, material, this.config.maxItemsPerSection)
      const last = material[material.length - 1]!
      const memberRows = material.filter(row => row.kind !== 'agent').length
      const model = `${endpoint.provider}/${endpoint.model}`
      await transaction(this.pool, async (client) => {
        await client.query(`INSERT INTO harness.project_journal(
            organization_id,project_id,kind,content,activity_count,model,generated_at,created_at,updated_at)
          VALUES($1,$2,'current',$3::jsonb,$4,$5,now(),now(),now())
          ON CONFLICT (organization_id,project_id) WHERE kind='current'
          DO UPDATE SET content=excluded.content,activity_count=excluded.activity_count,
            model=excluded.model,generated_at=excluded.generated_at,updated_at=now()`,
        [this.context.organizationId, internal, JSON.stringify(content), memberRows, model])
        await client.query(`INSERT INTO harness.project_journal(
            organization_id,project_id,kind,period_key,content,activity_count,
            period_start,period_end,model,generated_at,created_at,updated_at)
          VALUES($1,$2,'period',$3,$4::jsonb,$5,$6,$7,$8,now(),now(),now())
          ON CONFLICT (organization_id,project_id,period_key) WHERE kind='period'
          DO UPDATE SET content=excluded.content,activity_count=excluded.activity_count,
            period_end=excluded.period_end,model=excluded.model,generated_at=excluded.generated_at,updated_at=now()`,
        [this.context.organizationId, internal, periodKey, JSON.stringify(content), memberRows,
          material[0]!.occurredAt.toISOString(), last.occurredAt.toISOString(), model])
        await client.query(`UPDATE harness.project_journal_state
          SET watermark_ts=$3,watermark_session=$4,watermark_seq=$5,
            last_run_at=now(),generating_since=NULL,last_error=NULL,updated_at=now()
          WHERE organization_id=$1 AND project_id=$2`,
        [this.context.organizationId, internal,
          last.occurredAt.toISOString(), last.sessionId, last.seq])
      })
    } catch (error: unknown) {
      await this.fail(internal, error instanceof Error ? error.message : String(error))
    }
  }

  /** Resolve the project's default route into a callable endpoint, or undefined. */
  private async resolveEndpoint(projectId: number): Promise<DigestEndpoint | undefined> {
    const governance = this.deps.governance
    if (governance === undefined) return undefined
    const policy = await governance.policyForProject(projectId)
    const target = defaultModelFromPolicy(policy)
    if (target === undefined) return undefined
    const provider = policy.providers.find(entry => entry.provider === target.provider)
    if (provider === undefined || provider.protocol !== 'openai-completions') return undefined
    const apiKey = provider.credentialRef === undefined || governance.resolveManagedCredential === undefined
      ? null
      : await governance.resolveManagedCredential({ kind: 'project', id: projectId }, provider.credentialRef)
    return { provider: target.provider, model: target.model, baseURL: provider.baseURL, apiKey }
  }

  /** One non-streaming OpenAI-completions request bounded by the request timeout. */
  private async callModel(endpoint: DigestEndpoint, prompt: string): Promise<string> {
    const url = `${endpoint.baseURL.replace(/\/+$/, '')}/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.apiKey === null ? {} : { authorization: `Bearer ${endpoint.apiKey}` }),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: this.config.maxOutputTokens,
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    })
    if (!response.ok) throw new Error(`digest model request failed: ${String(response.status)}`)
    const body = await response.json() as { choices?: { message?: { content?: unknown } }[] }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content === '') throw new Error('digest model returned no content')
    return content
  }

  /** Read the per-project digest state row, if any. */
  private async stateRow(internal: string): Promise<StateRow | undefined> {
    const result = await this.pool.query<StateRow>(`SELECT watermark_ts,watermark_session,watermark_seq,
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
      WHERE organization_id=$1 AND project_id=$2
      ORDER BY CASE kind WHEN 'current' THEN 0 ELSE 1 END, generated_at DESC LIMIT 26`,
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
      WHERE organization_id=$1 AND project_id=$2 AND kind='period' AND period_key=$3`,
    [this.context.organizationId, internal, periodKey])
    return result.rows[0]
  }

  /** The rolling current entry, if any. */
  private async currentEntry(internal: string): Promise<JournalRow | undefined> {
    const result = await this.pool.query<JournalRow>(`SELECT id,kind,period_key,content,activity_count,
      period_start,period_end,model,generated_at FROM harness.project_journal
      WHERE organization_id=$1 AND project_id=$2 AND kind='current'`,
    [this.context.organizationId, internal])
    return result.rows[0]
  }

  private async publicIdOf(internal: string): Promise<number | null> {
    const result = await this.pool.query<{ public_id: string }>(
      'SELECT public_id::text FROM harness.projects WHERE organization_id=$1 AND id=$2',
      [this.context.organizationId, internal])
    const value = result.rows[0]?.public_id
    return value === undefined ? null : Number(value)
  }

  private async projectName(internal: string): Promise<string | undefined> {
    const result = await this.pool.query<{ name: string }>(
      'SELECT name FROM harness.projects WHERE organization_id=$1 AND id=$2',
      [this.context.organizationId, internal])
    return result.rows[0]?.name
  }

  private async clearLease(internal: string): Promise<void> {
    await this.pool.query(`UPDATE harness.project_journal_state
      SET generating_since=NULL,updated_at=now() WHERE organization_id=$1 AND project_id=$2`,
    [this.context.organizationId, internal])
  }

  /** Record a pass failure and release the lease so a later sweep retries. */
  private async fail(internal: string, message: string): Promise<void> {
    await this.pool.query(`UPDATE harness.project_journal_state
      SET generating_since=NULL,last_error=$3,updated_at=now()
      WHERE organization_id=$1 AND project_id=$2`,
    [this.context.organizationId, internal, message.slice(0, 500)])
  }
}

/** Selected labels and custom text of a claimed answer, bounded to one line. */
function answerSummary(outcome: unknown): string {
  const answers = (outcome as { answers?: unknown } | null)?.answers
  if (!Array.isArray(answers)) return ''
  return answers.map((entry) => {
    const item = entry as { selected?: unknown; custom?: unknown }
    const selected = Array.isArray(item.selected)
      ? item.selected.filter((label): label is string => typeof label === 'string').join('、')
      : ''
    return [selected, typeof item.custom === 'string' ? item.custom : '']
      .filter(text => text !== '').join('：')
  }).filter(text => text !== '').join('；').slice(0, 300)
}

/** Asked question texts from a serialized `tool/call` event data payload. */
function questionText(raw: string | null): string | undefined {
  if (raw === null) return undefined
  try {
    const questions = (JSON.parse(raw) as { arguments?: { questions?: unknown } }).arguments?.questions
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
