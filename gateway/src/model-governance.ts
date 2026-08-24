import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { UserRow } from './auth.ts'

export type CredentialClass = 'company' | 'personal' | 'unknown'
export type UsageStatus = 'succeeded' | 'failed' | 'cancelled' | 'missing-usage' | 'denied'
export type UsagePricingStatus = 'priced' | 'unpriced' | 'configured-zero' | 'mixed' | 'historical-unknown' | 'none'

/** Provider ids reserved for organization-managed routes. */
export const ORGANIZATION_PROVIDER_PATTERN = /^org-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Wire protocols currently supported by organization-managed pi-ai routes. */
export type ModelProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** Lifecycle state of one organization-managed model Provider. */
export type ModelProviderStatus = 'draft' | 'enabled' | 'disabled' | 'archived'

/** Persistence origin; legacy catalog rows remain drafts until replaced explicitly. */
export type ModelProviderSource = 'managed' | 'legacy-catalog'

/** Authentication supported by the initial organization Provider implementation. */
export type ModelProviderAuthMode = 'api-key' | 'none'

/** Organization Provider fields accepted by the Gateway control plane. */
export interface ModelProviderInput {
  provider: string
  displayName: string
  driver: 'pi-ai'
  protocol: ModelProviderProtocol
  baseURL: string
  authMode: ModelProviderAuthMode
  status: ModelProviderStatus
  /** New plaintext value, `null` to clear, or absent to keep the stored credential. */
  credential?: string | null
  /** Complete pi-ai profile fields supplied by the shared models editor. */
  profile?: Record<string, unknown>
}

/** Organization Provider metadata safe to return from the admin API. */
export interface ModelProviderRow {
  provider: string
  displayName: string
  driver: 'pi-ai'
  protocol: ModelProviderProtocol | null
  baseURL: string | null
  authMode: ModelProviderAuthMode
  status: ModelProviderStatus
  credentialRef: string | null
  credentialConfigured: boolean
  source: ModelProviderSource
  revision: number
  modelCount: number
  /** Complete redacted pi-ai profile used by the shared organization editor. */
  profile?: Record<string, unknown>
}

/** Enabled organization Provider profile projected into one managed runtime. */
export interface RuntimeModelProvider {
  provider: string
  displayName: string
  driver: 'pi-ai'
  protocol: ModelProviderProtocol
  baseURL: string
  credentialRef?: string
  /** Provider-level pi-ai fields that are not represented by governance columns. */
  profile?: Record<string, unknown>
  models: Array<{
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    input?: Array<'text' | 'image'>
    reasoningEfforts?: false | Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>
    compat?: { thinkingFormat?: string; supportsReasoningEffort?: boolean }
  }>
}

/** Complete authorization and Provider projection consumed by the runtime plugin. */
export interface RuntimeModelPolicy {
  version: number
  defaultAllowed: false
  models: Array<{ provider: string; model: string; allowed: boolean }>
  providers: RuntimeModelProvider[]
}

/** One path-addressed edit accepted by the organization models settings facade. */
export type ModelSettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Redacted settings namespace returned to the admin models plugin. */
export interface OrganizationModelSettingsView {
  writable: boolean
  hasDocument: boolean
  namespaces: Array<{
    ns: 'llm-pi-ai'
    schema: unknown
    value: unknown
    base?: unknown
    user?: unknown
    applies: 'live'
    secrets: Array<{ path: string[]; set: boolean }>
    revision: number
  }>
}

/** Credential state exposed by the organization settings facade. */
export interface OrganizationCredentialView {
  configured: boolean
  source: 'organization'
  writable: true
}

/** Durable owner charged for one model-usage record. */
export type ModelUsageSubject = { kind: 'user'; id: number } | { kind: 'project'; id: number }

export interface ModelRow {
  provider: string
  model: string
  displayName: string
  enabled: boolean
  adminAllowed: boolean
  userAllowed: boolean
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheWriteMicrosPerMillion: number
}

export interface UsageEvent {
  eventId: string
  occurredAt: number
  provider: string
  model: string
  purpose: string
  sessionId?: string
  /** Public user id that initiated a shared-project request, when known. */
  actorUserId?: number
  /** Public project id carried by the participant claim for scope verification. */
  actorProjectId?: number
  credentialSource: string
  credentialClass: CredentialClass
  status: UsageStatus
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

/** A personal Provider/model configuration change reported by a user runtime. */
export interface ModelRegistrationEvent {
  /** Discriminates this record from a model usage event on the intake wire. */
  kind: 'model-registration'
  /** Stable id used for at-least-once delivery deduplication. */
  eventId: string
  /** Client commit time in epoch milliseconds. */
  occurredAt: number
  /** Provider route affected by the configuration change. */
  provider: string
  /** Model id affected by a model-level action. */
  model?: string
  /** Semantic change made to the personal configuration. */
  action: 'provider-created' | 'provider-modified' | 'provider-deleted'
    | 'model-created' | 'model-modified' | 'model-deleted'
  /** This event stream is intentionally limited to personal settings. */
  scope: 'personal'
}

/** One persisted personal Provider/model registration event. */
export interface ModelRegistrationRow {
  eventId: string
  userId: number
  occurredAt: number
  receivedAt: number
  provider: string
  model: string | null
  action: ModelRegistrationEvent['action']
  scope: 'personal'
}

/** Filters and pagination for the administrator's registration audit view. */
export interface ModelRegistrationFilter {
  userId?: number
  provider?: string
  model?: string
  action?: ModelRegistrationEvent['action']
  fromMs?: number
  toMs?: number
  offset?: number
  limit?: number
}

/** Current-state and history totals for personal model registrations. */
export interface ModelRegistrationSummary {
  providerCount: number
  modelCount: number
  eventCount: number
  createdCount: number
  modifiedCount: number
  deletedCount: number
}

/** Registration history rows together with the corresponding totals. */
export interface ModelRegistrationReport {
  summary: ModelRegistrationSummary
  rows: ModelRegistrationRow[]
}

export interface UsageSummary {
  month: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCostMicros: number
  companyCostMicros: number
  calls: number
  missingUsageCalls: number
  tokenLimit: number | null
  companyCostMicrosLimit: number | null
  /** Price coverage; absent only for legacy SQLite callers. */
  pricing?: UsagePricingView
  alerts: Array<{ metric: 'tokens' | 'company-cost'; threshold: 80 | 100; createdAt: number }>
}

/** Price coverage for one usage aggregate. */
export interface UsagePricingView {
  status: UsagePricingStatus
  pricedCalls: number
  unpricedCalls: number
  configuredZeroCalls: number
  unknownCalls: number
}

/** Usage measure without quota or alert state. */
export interface UsageMeasure {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCostMicros: number
  companyCostMicros: number
  calls: number
  missingUsageCalls: number
  pricing?: UsagePricingView
}

/** One user's confirmed contribution to shared project calls. */
export interface UsageContributorRow extends UsageMeasure {
  userId: number
  username: string
  archived?: boolean
  projectCount: number
}

/** Contributor report for all projects or one selected project. */
export interface UsageContributorReport {
  month: string
  timeZone: string
  projectId?: number
  rows: UsageContributorRow[]
  unattributed: UsageMeasure
}

/** Admin usage overview separating billable subjects from user activity. */
export interface UsageOverview {
  month: string
  timeZone: string
  personal: UsageMeasure
  projects: UsageMeasure
  unattributedProjects: UsageMeasure
  users: Array<{
    userId: number
    username: string
    archived?: boolean
    personal: UsageSummary
    projectContribution: UsageMeasure
  }>
}

/** Operational checks for one natural-month usage window. */
export interface UsageHealth {
  month: string
  timeZone: string
  missingUsageCalls: number
  unattributedProjectCalls: number
  unattributedProjectTokens: number
  unpricedCalls: number
  historicalUnknownCalls: number
  maxIntakeLagMs: number
}

/** Stored project quota source plus the Token and company-cost limits currently in force. */
export interface ProjectQuotaView {
  source: 'inherit' | 'independent'
  tokenLimit: number | null
  companyCostMicrosLimit: number | null
}

const nonEmpty = (value: string, name: string): string => {
  const accepted = value.trim()
  if (accepted === '') throw new Error(`${name} must not be empty`)
  return accepted
}

const nonnegative = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}


function credentialClassOf(source: string): CredentialClass {
  if (source === 'file' || source === 'project-env' || source === 'request') return 'personal'
  if (source === 'organization' || source === 'env' || source === 'process' || source === 'user-env') return 'company'
  return 'unknown'
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function dateParts(time: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(time)
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') }
}

function localMidnight(year: number, month: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, 1)
  let candidate = target
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = dateParts(candidate, timeZone)
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    const next = candidate + target - represented
    if (next === candidate) return candidate
    candidate = next
  }
  return candidate
}

function monthBounds(month: string, timeZone: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM')
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText); const value = Number(monthText)
  if (value < 1 || value > 12) throw new Error('month must be YYYY-MM')
  const nextYear = value === 12 ? year + 1 : year
  const nextMonth = value === 12 ? 1 : value + 1
  return { start: localMidnight(year, value, timeZone), end: localMidnight(nextYear, nextMonth, timeZone) }
}

function monthOf(time: number, timeZone: string): string {
  const parts = dateParts(time, timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`
}

export class ModelGovernanceService {
  constructor(private readonly db: Database.Database, private readonly timeZone = 'Asia/Shanghai') {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  }

  listProviders(): ModelProviderRow[] {
    const rows = this.db.prepare(`SELECT provider,COUNT(*) model_count FROM model_catalog
      GROUP BY provider ORDER BY provider`).all() as Array<{ provider: string; model_count: number }>
    return rows.map(row => ({
      provider: row.provider,
      displayName: row.provider,
      driver: 'pi-ai',
      protocol: null,
      baseURL: null,
      authMode: 'none',
      status: 'draft',
      credentialRef: null,
      credentialConfigured: false,
      source: 'legacy-catalog',
      revision: 1,
      modelCount: row.model_count,
    }))
  }

  upsertProvider(_input: ModelProviderInput): void {
    throw new Error('SQLite model governance has no organization Provider support')
  }

  resolveOrganizationCredential(_subject: ModelUsageSubject, _ref: string): string | null {
    return null
  }

  describeOrganizationModelSettings(): OrganizationModelSettingsView {
    throw new Error('SQLite model governance has no organization settings support')
  }

  mutateOrganizationModelSettings(_ops: ModelSettingsPathOp[], _expectedRevision?: number): OrganizationModelSettingsView {
    throw new Error('SQLite model governance has no organization settings support')
  }

  describeOrganizationCredentials(_refs: string[]): Record<string, OrganizationCredentialView> {
    throw new Error('SQLite model governance has no organization credential support')
  }

  setOrganizationCredential(_ref: string, _value: string): void {
    throw new Error('SQLite model governance has no organization credential support')
  }

  unsetOrganizationCredential(_ref: string): void {
    throw new Error('SQLite model governance has no organization credential support')
  }

  discoverOrganizationModels(_request: { provider?: string; baseURL?: string; api?: string; apiKey?: string }): Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }> {
    throw new Error('SQLite model governance has no organization model discovery support')
  }

  listModels(): ModelRow[] {
    const rows = this.db.prepare(`
      SELECT m.*,
        COALESCE(a.allowed, 1) AS admin_allowed,
        COALESCE(u.allowed, 0) AS user_allowed,
        COALESCE(p.input_micros_per_million, 0) AS input_price,
        COALESCE(p.output_micros_per_million, 0) AS output_price,
        COALESCE(p.cache_read_micros_per_million, 0) AS cache_read_price,
        COALESCE(p.cache_write_micros_per_million, 0) AS cache_write_price
      FROM model_catalog m
      LEFT JOIN model_role_access a ON a.role='admin' AND a.provider=m.provider AND a.model=m.model
      LEFT JOIN model_role_access u ON u.role='user' AND u.provider=m.provider AND u.model=m.model
      LEFT JOIN model_prices p ON p.id = (
        SELECT id FROM model_prices px WHERE px.provider=m.provider AND px.model=m.model
        ORDER BY effective_at DESC, id DESC LIMIT 1
      )
      ORDER BY m.provider, m.model
    `).all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      provider: String(row.provider), model: String(row.model), displayName: String(row.display_name),
      enabled: row.enabled === 1, adminAllowed: row.admin_allowed === 1, userAllowed: row.user_allowed === 1,
      inputMicrosPerMillion: Number(row.input_price), outputMicrosPerMillion: Number(row.output_price),
      cacheReadMicrosPerMillion: Number(row.cache_read_price), cacheWriteMicrosPerMillion: Number(row.cache_write_price),
    }))
  }

  upsertModel(input: Omit<ModelRow, 'adminAllowed' | 'userAllowed'> & { adminAllowed?: boolean; userAllowed?: boolean }): void {
    const provider = nonEmpty(input.provider, 'provider')
    const model = nonEmpty(input.model, 'model')
    const now = Date.now()
    const apply = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO model_catalog(provider, model, display_name, enabled, created_at, updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(provider,model) DO UPDATE SET display_name=excluded.display_name,
        enabled=excluded.enabled, updated_at=excluded.updated_at`)
        .run(provider, model, nonEmpty(input.displayName, 'displayName'), input.enabled ? 1 : 0, now, now)
      for (const [role, allowed] of [['admin', input.adminAllowed ?? true], ['user', input.userAllowed ?? false]] as const) {
        this.db.prepare(`INSERT INTO model_role_access(role,provider,model,allowed) VALUES(?,?,?,?)
          ON CONFLICT(role,provider,model) DO UPDATE SET allowed=excluded.allowed`).run(role, provider, model, allowed ? 1 : 0)
      }
      const prices = [input.inputMicrosPerMillion, input.outputMicrosPerMillion,
        input.cacheReadMicrosPerMillion, input.cacheWriteMicrosPerMillion]
        .map((value, index) => nonnegative(value, `price[${index}]`))
      const latest = this.db.prepare(`SELECT MAX(effective_at) AS at FROM model_prices WHERE provider=? AND model=?`)
        .get(provider, model) as { at: number | null }
      const effectiveAt = Math.max(now, (latest.at ?? -1) + 1)
      this.db.prepare(`INSERT INTO model_prices(provider,model,effective_at,input_micros_per_million,
        output_micros_per_million,cache_read_micros_per_million,cache_write_micros_per_million)
        VALUES(?,?,?,?,?,?,?)`).run(provider, model, effectiveAt, ...prices)
    })
    apply()
  }

  setUserAccess(userId: number, provider: string, model: string, allowed: boolean | null): void {
    provider = nonEmpty(provider, 'provider')
    model = nonEmpty(model, 'model')
    if (this.db.prepare(`SELECT 1 FROM model_catalog WHERE provider=? AND model=?`).get(provider, model) === undefined) {
      throw new Error(`unknown model ${provider}/${model}`)
    }
    if (allowed === null) {
      this.db.prepare(`DELETE FROM model_user_access WHERE user_id=? AND provider=? AND model=?`).run(userId, provider, model)
      return
    }
    this.db.prepare(`INSERT INTO model_user_access(user_id,provider,model,allowed) VALUES(?,?,?,?)
      ON CONFLICT(user_id,provider,model) DO UPDATE SET allowed=excluded.allowed`).run(userId, provider, model, allowed ? 1 : 0)
  }

  userOverrides(userId: number): Array<{ provider: string; model: string; allowed: boolean }> {
    const rows = this.db.prepare(`SELECT provider,model,allowed FROM model_user_access WHERE user_id=? ORDER BY provider,model`)
      .all(userId) as Array<{ provider: string; model: string; allowed: number }>
    return rows.map(row => ({ provider: row.provider, model: row.model, allowed: row.allowed === 1 }))
  }

  setProjectAccess(
    _projectId: number,
    _provider: string,
    _model: string,
    _allowed: boolean | null,
  ): void {
    throw new Error('SQLite model governance has no project runtime support')
  }

  setAllProjectAccess(_projectId: number, _allowed: true | null): void {
    throw new Error('SQLite model governance has no project runtime support')
  }

  projectOverrides(_projectId: number): Array<{ provider: string; model: string; allowed: boolean }> {
    throw new Error('SQLite model governance has no project runtime support')
  }

  projectQuota(_projectId: number): ProjectQuotaView {
    const roleQuota = this.db.prepare(
      `SELECT * FROM model_quotas WHERE subject_type='role' AND subject_id=?`,
    ).get('user') as { token_limit: number | null; company_cost_micros_limit: number | null } | undefined
    const quota = (value: number | null | undefined): number | null =>
      value === undefined || value === -1 ? null : value
    return {
      source: 'inherit',
      tokenLimit: quota(roleQuota?.token_limit),
      companyCostMicrosLimit: quota(roleQuota?.company_cost_micros_limit),
    }
  }

  policyFor(user: UserRow): RuntimeModelPolicy {
    const rows = this.db.prepare(`SELECT m.provider,m.model,m.enabled,
      COALESCE(x.allowed,r.allowed,CASE WHEN ?='admin' THEN 1 ELSE 0 END) AS allowed
      FROM model_catalog m
      LEFT JOIN model_role_access r ON r.role=? AND r.provider=m.provider AND r.model=m.model
      LEFT JOIN model_user_access x ON x.user_id=? AND x.provider=m.provider AND x.model=m.model
      ORDER BY m.provider,m.model`).all(user.role, user.role, user.id) as Array<{
        provider: string; model: string; enabled: number; allowed: number
      }>
    return {
      version: Date.now(),
      // The catalog is the sole authorization source for every role; unlisted
      // routes fall through to the plugin's user-declared allowance instead.
      defaultAllowed: false,
      models: rows.map(row => ({ provider: row.provider, model: row.model, allowed: row.enabled === 1 && row.allowed === 1 })),
      providers: [],
    }
  }

  policyForProject(_projectId: number): RuntimeModelPolicy {
    throw new Error('SQLite model governance has no project runtime support')
  }

  private userId(subject: ModelUsageSubject): number {
    if (subject.kind !== 'user') throw new Error('SQLite model governance has no project runtime support')
    return subject.id
  }

  issueIntakeToken(subject: ModelUsageSubject): string {
    const userId = this.userId(subject)
    const token = randomBytes(32).toString('base64url')
    this.db.prepare(`INSERT INTO model_intake_tokens(user_id,token_hash,created_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at`)
      .run(userId, tokenHash(token), Date.now())
    return token
  }

  subjectForIntakeToken(token: string): ModelUsageSubject | null {
    const row = this.db.prepare(`SELECT user_id FROM model_intake_tokens WHERE token_hash=?`).get(tokenHash(token)) as
      { user_id: number } | undefined
    return row === undefined ? null : { kind: 'user', id: row.user_id }
  }

  setQuota(
    subjectType: 'role' | 'user' | 'project',
    subjectId: string,
    tokenLimit: number | null | 'inherit',
    costLimit: number | null | 'inherit',
  ): void {
    subjectId = nonEmpty(subjectId, 'subjectId')
    if (subjectType === 'project') throw new Error('SQLite model governance has no project runtime support')
    if (subjectType === 'role' && subjectId !== 'admin' && subjectId !== 'user') throw new Error('role quota subject must be admin or user')
    if (subjectType === 'user' && (!Number.isSafeInteger(Number(subjectId)) || Number(subjectId) <= 0)) throw new Error('user quota subject must be a positive user id')
    if (subjectType === 'role' && (tokenLimit === 'inherit' || costLimit === 'inherit')) {
      throw new Error('role quotas cannot inherit')
    }
    const stored = (value: number | null | 'inherit', name: string): number | null =>
      value === 'inherit' ? -1 : value === null ? null : nonnegative(value, name)
    if (subjectType === 'user' && tokenLimit === 'inherit' && costLimit === 'inherit') {
      this.db.prepare(`DELETE FROM model_quotas WHERE subject_type='user' AND subject_id=?`).run(subjectId)
      return
    }
    this.db.prepare(`INSERT INTO model_quotas(subject_type,subject_id,token_limit,company_cost_micros_limit)
      VALUES(?,?,?,?) ON CONFLICT(subject_type,subject_id) DO UPDATE SET token_limit=excluded.token_limit,
      company_cost_micros_limit=excluded.company_cost_micros_limit`)
      .run(subjectType, subjectId, stored(tokenLimit, 'tokenLimit'), stored(costLimit, 'companyCostMicrosLimit'))
  }

  ingest(subject: ModelUsageSubject, event: UsageEvent): { inserted: boolean; alerts: number } {
    const userId = this.userId(subject)
    if (event === null || typeof event !== 'object') throw new Error('usage event must be an object')
    nonEmpty(event.eventId, 'eventId')
    if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) throw new Error('occurredAt must be a non-negative safe integer')
    if (event.actorUserId !== undefined && (!Number.isSafeInteger(event.actorUserId) || event.actorUserId <= 0 || event.actorUserId !== userId)) {
      throw new Error('actorUserId must match the personal usage subject')
    }
    if (event.actorProjectId !== undefined) throw new Error('actorProjectId is not valid for personal usage')
    if (!['company', 'personal', 'unknown'].includes(event.credentialClass)) throw new Error('invalid credentialClass')
    if (!['succeeded', 'failed', 'cancelled', 'missing-usage', 'denied'].includes(event.status)) throw new Error('invalid status')
    if (typeof event.credentialSource !== 'string') throw new Error('credentialSource must be a string')
    const credentialClass = credentialClassOf(event.credentialSource)
    if (event.credentialClass !== credentialClass) throw new Error('credentialClass does not match credentialSource')
    const usage = event.usage
    const buckets = {
      input: nonnegative(usage?.inputTokens ?? 0, 'inputTokens'),
      output: nonnegative(usage?.outputTokens ?? 0, 'outputTokens'),
      read: nonnegative(usage?.cacheReadTokens ?? 0, 'cacheReadTokens'),
      write: nonnegative(usage?.cacheWriteTokens ?? 0, 'cacheWriteTokens'),
    }
    const price = this.db.prepare(`SELECT * FROM model_prices WHERE provider=? AND model=? AND effective_at<=?
      ORDER BY effective_at DESC,id DESC LIMIT 1`).get(event.provider, event.model, event.occurredAt) as
      | { input_micros_per_million: number; output_micros_per_million: number;
        cache_read_micros_per_million: number; cache_write_micros_per_million: number }
      | undefined
    const estimated = price === undefined ? 0 : Math.round((
      buckets.input * price.input_micros_per_million + buckets.output * price.output_micros_per_million
      + buckets.read * price.cache_read_micros_per_million + buckets.write * price.cache_write_micros_per_million
    ) / 1_000_000)
    const companyCost = credentialClass === 'personal' ? 0 : estimated
    const insert = this.db.prepare(`INSERT OR IGNORE INTO model_usage(event_id,user_id,occurred_at,received_at,provider,model,
      purpose,session_id,credential_source,credential_class,status,input_tokens,output_tokens,cache_read_tokens,
      cache_write_tokens,estimated_cost_micros,company_cost_micros) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(event.eventId, userId, event.occurredAt, Date.now(), nonEmpty(event.provider, 'provider'),
        nonEmpty(event.model, 'model'), nonEmpty(event.purpose, 'purpose'), event.sessionId ?? null,
        event.credentialSource, credentialClass, event.status, buckets.input, buckets.output, buckets.read,
        buckets.write, estimated, companyCost)
    if (insert.changes === 0) return { inserted: false, alerts: 0 }
    return { inserted: true, alerts: this.evaluateAlerts(userId, monthOf(event.occurredAt, this.timeZone)) }
  }

  ingestRegistration(subject: ModelUsageSubject, event: ModelRegistrationEvent): { inserted: boolean } {
    const userId = this.userId(subject)
    if (event === null || typeof event !== 'object' || event.kind !== 'model-registration') {
      throw new Error('model registration event must have kind model-registration')
    }
    nonEmpty(event.eventId, 'eventId')
    if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) {
      throw new Error('occurredAt must be a non-negative safe integer')
    }
    const provider = nonEmpty(event.provider, 'provider')
    const actions: ModelRegistrationEvent['action'][] = [
      'provider-created', 'provider-modified', 'provider-deleted',
      'model-created', 'model-modified', 'model-deleted',
    ]
    if (!actions.includes(event.action)) throw new Error('invalid model registration action')
    if (event.scope !== 'personal') throw new Error('model registration scope must be personal')
    const modelAction = event.action.startsWith('model-')
    const model = modelAction ? nonEmpty(event.model ?? '', 'model') : null
    if (!modelAction && event.model !== undefined) throw new Error('provider registration events cannot name a model')
    const result = this.db.prepare(`INSERT OR IGNORE INTO model_registration_events(
      event_id,user_id,occurred_at,received_at,provider,model,action,scope
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      event.eventId, userId, event.occurredAt, Date.now(), provider, model, event.action, event.scope,
    )
    return { inserted: result.changes !== 0 }
  }

  registrationReport(filter: ModelRegistrationFilter = {}): ModelRegistrationReport {
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 100
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('registration offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('registration limit must be from 1 through 500')
    const clauses: string[] = []
    const values: unknown[] = []
    if (filter.userId !== undefined && (!Number.isSafeInteger(filter.userId) || filter.userId <= 0)) {
      throw new Error('userId must be a positive safe integer')
    }
    if (filter.userId !== undefined) { clauses.push('user_id=?'); values.push(filter.userId) }
    if (filter.provider !== undefined) { clauses.push('provider=?'); values.push(nonEmpty(filter.provider, 'provider')) }
    if (filter.model !== undefined) { clauses.push('model=?'); values.push(nonEmpty(filter.model, 'model')) }
    if (filter.action !== undefined) {
      const actions: readonly ModelRegistrationEvent['action'][] = [
        'provider-created', 'provider-modified', 'provider-deleted',
        'model-created', 'model-modified', 'model-deleted',
      ]
      if (!actions.includes(filter.action)) throw new Error('invalid model registration action')
      clauses.push('action=?'); values.push(filter.action)
    }
    if (filter.fromMs !== undefined && (!Number.isSafeInteger(filter.fromMs) || filter.fromMs < 0)) {
      throw new Error('fromMs must be a non-negative safe integer')
    }
    if (filter.toMs !== undefined && (!Number.isSafeInteger(filter.toMs) || filter.toMs < 0)) {
      throw new Error('toMs must be a non-negative safe integer')
    }
    if (filter.fromMs !== undefined) { clauses.push('occurred_at>=?'); values.push(filter.fromMs) }
    if (filter.toMs !== undefined) { clauses.push('occurred_at<?'); values.push(filter.toMs) }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const all = this.db.prepare(`SELECT event_id,user_id,occurred_at,received_at,provider,model,action,scope
      FROM model_registration_events${where} ORDER BY occurred_at DESC,event_id DESC`).all(...values) as Array<{
        event_id: string; user_id: number; occurred_at: number; received_at: number; provider: string;
        model: string | null; action: ModelRegistrationEvent['action']; scope: 'personal'
      }>
    const providerState = new Map<string, ModelRegistrationEvent['action']>()
    const modelState = new Map<string, ModelRegistrationEvent['action']>()
    for (const row of [...all].sort((a, b) => a.occurred_at - b.occurred_at
      || a.received_at - b.received_at || a.event_id.localeCompare(b.event_id))) {
      if (row.model === null) providerState.set(`${row.user_id}\0${row.provider}`, row.action)
      else modelState.set(`${row.user_id}\0${row.provider}\0${row.model}`, row.action)
    }
    for (const [key, action] of modelState) {
      if (action === 'model-deleted') continue
      const providerKey = key.slice(0, key.lastIndexOf('\0'))
      if (!providerState.has(providerKey)) providerState.set(providerKey, 'provider-created')
    }
    const actionCount = (prefix: string): number => all.filter(row => row.action.startsWith(prefix)).length
    const rows = all.slice(offset, offset + limit).map(row => ({
      eventId: row.event_id, userId: row.user_id, occurredAt: row.occurred_at, receivedAt: row.received_at,
      provider: row.provider, model: row.model, action: row.action, scope: row.scope,
    }))
    return {
      summary: {
        providerCount: [...providerState.values()].filter(action => action !== 'provider-deleted').length,
        modelCount: [...modelState.values()].filter(action => action !== 'model-deleted').length,
        eventCount: all.length,
        createdCount: actionCount('provider-created') + actionCount('model-created'),
        modifiedCount: actionCount('provider-modified') + actionCount('model-modified'),
        deletedCount: actionCount('provider-deleted') + actionCount('model-deleted'),
      },
      rows,
    }
  }

  summary(subject: ModelUsageSubject, month = monthOf(Date.now(), this.timeZone)): UsageSummary {
    const userId = this.userId(subject)
    const { start, end } = monthBounds(month, this.timeZone)
    const row = this.db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS input,COALESCE(SUM(output_tokens),0) AS output,
      COALESCE(SUM(cache_read_tokens),0) AS read,COALESCE(SUM(cache_write_tokens),0) AS write,
      COALESCE(SUM(estimated_cost_micros),0) AS cost,COALESCE(SUM(company_cost_micros),0) AS company,
      COUNT(*) AS calls,COALESCE(SUM(CASE WHEN status='missing-usage' THEN 1 ELSE 0 END),0) AS missing
      FROM model_usage WHERE user_id=? AND occurred_at>=? AND occurred_at<?`).get(userId, start, end) as {
        input: number; output: number; read: number; write: number; cost: number; company: number; calls: number; missing: number
      }
    const user = this.db.prepare(`SELECT role FROM users WHERE id=? AND deleted_at IS NULL`).get(userId) as { role: string } | undefined
    const userQuota = this.db.prepare(`SELECT * FROM model_quotas WHERE subject_type='user' AND subject_id=?`).get(String(userId)) as
      { token_limit: number | null; company_cost_micros_limit: number | null } | undefined
    const roleQuota = user === undefined ? undefined : this.db.prepare(
      `SELECT * FROM model_quotas WHERE subject_type='role' AND subject_id=?`,
    ).get(user.role) as { token_limit: number | null; company_cost_micros_limit: number | null } | undefined
    const alerts = this.db.prepare(`SELECT metric,threshold,created_at FROM model_usage_alerts WHERE user_id=? AND month=?
      ORDER BY CASE metric WHEN 'tokens' THEN 0 ELSE 1 END, threshold`).all(userId, month) as Array<{ metric: 'tokens' | 'company-cost'; threshold: 80 | 100; created_at: number }>
    const total = row.input + row.output + row.read + row.write
    if (!Number.isSafeInteger(total)) throw new Error('total usage tokens exceed safe integer range')
    const quota = (userValue: number | null | undefined, roleValue: number | null | undefined): number | null =>
      userValue === undefined || userValue === -1 ? roleValue ?? null : userValue
    return {
      month, inputTokens: row.input, outputTokens: row.output, cacheReadTokens: row.read, cacheWriteTokens: row.write,
      totalTokens: total, estimatedCostMicros: row.cost, companyCostMicros: row.company, calls: row.calls,
      missingUsageCalls: row.missing, tokenLimit: quota(userQuota?.token_limit, roleQuota?.token_limit),
      companyCostMicrosLimit: quota(userQuota?.company_cost_micros_limit, roleQuota?.company_cost_micros_limit),
      alerts: alerts.map(alert => ({ metric: alert.metric, threshold: alert.threshold, createdAt: alert.created_at })),
    }
  }

  usageContributors(month = monthOf(Date.now(), this.timeZone), projectId?: number): UsageContributorReport {
    if (projectId !== undefined) throw new Error('SQLite model governance has no project runtime support')
    return {
      month,
      timeZone: this.timeZone,
      rows: [],
      unattributed: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
        estimatedCostMicros: 0, companyCostMicros: 0, calls: 0, missingUsageCalls: 0,
        pricing: { status: 'none', pricedCalls: 0, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 },
      },
    }
  }

  usageOverview(month = monthOf(Date.now(), this.timeZone)): UsageOverview {
    const identities = this.db.prepare(`SELECT id,username,status,deleted_at FROM users ORDER BY id`).all() as Array<{
      id: number; username: string; status: 'active' | 'disabled'; deleted_at: number | null
    }>
    const users = identities.map(user => ({
      userId: user.id,
      username: user.username,
      archived: user.status !== 'active' || user.deleted_at !== null,
      personal: this.summary({ kind: 'user', id: user.id }, month),
      projectContribution: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
        estimatedCostMicros: 0, companyCostMicros: 0, calls: 0, missingUsageCalls: 0,
        pricing: { status: 'none' as const, pricedCalls: 0, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 },
      },
    }))
    const personal = users.reduce((sum, row) => ({
      inputTokens: sum.inputTokens + row.personal.inputTokens,
      outputTokens: sum.outputTokens + row.personal.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + row.personal.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.personal.cacheWriteTokens,
      totalTokens: sum.totalTokens + row.personal.totalTokens,
      estimatedCostMicros: sum.estimatedCostMicros + row.personal.estimatedCostMicros,
      companyCostMicros: sum.companyCostMicros + row.personal.companyCostMicros,
      calls: sum.calls + row.personal.calls,
      missingUsageCalls: sum.missingUsageCalls + row.personal.missingUsageCalls,
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
      estimatedCostMicros: 0, companyCostMicros: 0, calls: 0, missingUsageCalls: 0 })
    const empty: UsageMeasure = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
      estimatedCostMicros: 0, companyCostMicros: 0, calls: 0, missingUsageCalls: 0,
      pricing: { status: 'none', pricedCalls: 0, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 },
    }
    return { month, timeZone: this.timeZone, personal, projects: empty, unattributedProjects: empty, users }
  }

  usageHealth(month = monthOf(Date.now(), this.timeZone)): UsageHealth {
    const { start, end } = monthBounds(month, this.timeZone)
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='missing-usage' THEN 1 ELSE 0 END),0) missing,
      COALESCE(MAX(CASE WHEN received_at > occurred_at THEN received_at - occurred_at ELSE 0 END),0) lag
      FROM model_usage WHERE occurred_at>=? AND occurred_at<?`).get(start, end) as { missing: number; lag: number }
    if (!Number.isSafeInteger(row.missing) || row.missing < 0
      || !Number.isSafeInteger(row.lag) || row.lag < 0) throw new Error('usage health exceeds safe integer range')
    return { month, timeZone: this.timeZone, missingUsageCalls: row.missing, unattributedProjectCalls: 0,
      unattributedProjectTokens: 0, unpricedCalls: 0, historicalUnknownCalls: 0, maxIntakeLagMs: row.lag }
  }

  private evaluateAlerts(userId: number, month: string): number {
    const summary = this.summary({ kind: 'user', id: userId }, month)
    let inserted = 0
    for (const [metric, value, limit] of [
      ['tokens', summary.totalTokens, summary.tokenLimit],
      ['company-cost', summary.companyCostMicros, summary.companyCostMicrosLimit],
    ] as const) {
      if (limit === null || limit <= 0) continue
      for (const threshold of [80, 100] as const) {
        if (value * 100 < limit * threshold) continue
        inserted += this.db.prepare(`INSERT OR IGNORE INTO model_usage_alerts(user_id,month,metric,threshold,created_at)
          VALUES(?,?,?,?,?)`).run(userId, month, metric, threshold, Date.now()).changes
      }
    }
    return inserted
  }
}
