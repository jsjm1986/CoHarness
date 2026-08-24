import { createHash, randomBytes } from 'node:crypto'
import type { UserRow } from '../auth.ts'
import type {
  CredentialClass,
  ModelProviderInput,
  ModelProviderProtocol,
  ModelProviderRow,
  ModelUsageSubject,
  ModelRegistrationEvent,
  ModelRegistrationFilter,
  ModelRegistrationReport,
  ModelRegistrationRow,
  ModelRow,
  RuntimeModelPolicy,
  RuntimeModelProvider,
  UsageContributorReport,
  UsageContributorRow,
  UsageEvent,
  UsageHealth,
  UsageMeasure,
  UsageOverview,
  UsagePricingStatus,
  UsagePricingView,
  UsageSummary,
  ProjectQuotaView,
} from '../model-governance.ts'
import { ORGANIZATION_PROVIDER_PATTERN } from '../model-governance.ts'
import { OrganizationModelCredentialCipher } from '../organization-model-credentials.ts'
import type { Queryable } from './database.ts'
import { transaction } from './database.ts'
import { internalProjectId, internalUserId, type PostgresRuntimeContext } from './runtime-context.ts'
import {
  discoverOrganizationModels,
  organizationModelSettingsSchema,
  validateOrganizationProfiles,
} from '../organization-model-settings.ts'
import type {
  ModelSettingsPathOp,
  OrganizationCredentialView,
  OrganizationModelSettingsView,
} from '../model-governance.ts'

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

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function microsToDecimal(value: number): string {
  nonnegative(value, 'monetary value')
  return `${String(Math.floor(value / 1_000_000))}.${String(value % 1_000_000).padStart(6, '0')}`
}

function decimalToMicros(value: string | number): number {
  const text = String(value)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (match === null) throw new Error(`invalid non-negative decimal monetary value: ${text}`)
  const whole = Number(match[1])
  const fraction = (match[2] ?? '').padEnd(7, '0')
  let micros = whole * 1_000_000 + Number(fraction.slice(0, 6))
  if (Number(fraction[6]) >= 5) micros += 1
  if (!Number.isSafeInteger(micros)) throw new Error(`monetary value exceeds safe integer range: ${text}`)
  return micros
}

function safeCount(value: string | number, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} exceeds safe integer range`)
  return number
}

function dateParts(time: number, timeZone: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(time)
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

function localMidnight(year: number, month: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, 1)
  let candidate = target
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = dateParts(candidate, timeZone)
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    )
    const next = candidate + target - represented
    if (next === candidate) return candidate
    candidate = next
  }
  return candidate
}

function monthBounds(month: string, timeZone: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM')
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const value = Number(monthText)
  if (value < 1 || value > 12) throw new Error('month must be YYYY-MM')
  return {
    start: localMidnight(year, value, timeZone),
    end: localMidnight(value === 12 ? year + 1 : year, value === 12 ? 1 : value + 1, timeZone),
  }
}

function monthOf(time: number, timeZone: string): string {
  const parts = dateParts(time, timeZone)
  return `${String(parts.year)}-${String(parts.month).padStart(2, '0')}`
}

function roleForPostgres(role: 'admin' | 'user'): 'admin' | 'member' {
  return role === 'admin' ? 'admin' : 'member'
}

const PROVIDER_PROTOCOLS = new Set<ModelProviderProtocol>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

function providerCredentialRef(provider: string): string {
  return `DSH_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

function providerBaseURL(value: string): string {
  const accepted = nonEmpty(value, 'baseURL')
  let parsed: URL
  try {
    parsed = new URL(accepted)
  } catch {
    throw new Error('baseURL must be an absolute http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseURL must be an absolute http or https URL')
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new Error('baseURL must not contain credentials or a fragment')
  }
  return accepted.replace(/\/$/, '')
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

function setJsonPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor = root
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment]
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) cursor[segment] = {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  const leaf = path[path.length - 1]
  if (leaf === undefined) throw new Error('settings path must not be empty')
  cursor[leaf] = cloneJson(value)
}

function unsetJsonPath(root: Record<string, unknown>, path: readonly string[]): void {
  if (path.length === 0) throw new Error('settings path must not be empty')
  let cursor: Record<string, unknown> | undefined = root
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return
    cursor = next as Record<string, unknown>
  }
  delete cursor[path[path.length - 1] as string]
}

function apiKeyRefOf(profile: Record<string, unknown>): string | undefined {
  const value = profile.apiKeyEnv
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function profileModelsOf(profile: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = profile.models
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('provider models must be an array')
  return value.map((model, index) => jsonObject(model, `models[${index}]`))
}

interface UsageTotalsRow {
  input: string
  output: string
  read: string
  write: string
  cost: string
  company: string
  calls: string
  missing: string
  priced: string
  unpriced: string
  configured_zero: string
  unknown: string
}

interface UsageAlertRow {
  metric: 'tokens' | 'company-cost'
  threshold: 80 | 100
  created_at: Date
}

function usageSummary(
  month: string,
  row: UsageTotalsRow,
  tokenLimit: number | null,
  companyCostMicrosLimit: number | null,
  alerts: readonly UsageAlertRow[],
): UsageSummary {
  const measure = usageMeasure(row)
  return {
    month,
    ...measure,
    tokenLimit,
    companyCostMicrosLimit,
    alerts: alerts.map(alert => ({
      metric: alert.metric,
      threshold: alert.threshold,
      createdAt: alert.created_at.getTime(),
    })),
  }
}

function pricingView(row: UsageTotalsRow, calls: number): UsagePricingView {
  const pricedCalls = safeCount(row.priced, 'priced usage calls')
  const unpricedCalls = safeCount(row.unpriced, 'unpriced usage calls')
  const configuredZeroCalls = safeCount(row.configured_zero, 'configured-zero usage calls')
  const unknownCalls = safeCount(row.unknown, 'unknown pricing calls')
  const status: UsagePricingStatus = calls === 0
    ? 'none'
    : unknownCalls === calls
        ? 'historical-unknown'
      : pricedCalls === calls
        ? 'priced'
        : unpricedCalls === calls
          ? 'unpriced'
          : configuredZeroCalls === calls
            ? 'configured-zero'
            : 'mixed'
  return { status, pricedCalls, unpricedCalls, configuredZeroCalls, unknownCalls }
}

function usageMeasure(row: UsageTotalsRow): UsageMeasure {
  const input = safeCount(row.input, 'input tokens')
  const output = safeCount(row.output, 'output tokens')
  const read = safeCount(row.read, 'cache read tokens')
  const write = safeCount(row.write, 'cache write tokens')
  const calls = safeCount(row.calls, 'usage calls')
  const totalTokens = input + output + read + write
  if (!Number.isSafeInteger(totalTokens)) throw new Error('total usage tokens exceed safe integer range')
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    totalTokens,
    estimatedCostMicros: decimalToMicros(row.cost),
    companyCostMicros: decimalToMicros(row.company),
    calls,
    missingUsageCalls: safeCount(row.missing, 'missing usage calls'),
    pricing: pricingView(row, calls),
  }
}

function zeroUsageMeasure(): UsageMeasure {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCostMicros: 0,
    companyCostMicros: 0,
    calls: 0,
    missingUsageCalls: 0,
    pricing: { status: 'none', pricedCalls: 0, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 },
  }
}

/** PostgreSQL-backed model access, pricing, quotas, and usage accounting. */
export class PostgresModelGovernanceService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly credentialCipher: OrganizationModelCredentialCipher,
    private readonly timeZone = 'Asia/Shanghai',
  ) {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  }

  async listProviders(): Promise<ModelProviderRow[]> {
    const result = await this.context.pool.query<{
      provider: string
      display_name: string
      driver: 'pi-ai'
      protocol: ModelProviderProtocol | null
      base_url: string | null
      auth_mode: 'api-key' | 'none'
      status: 'draft' | 'enabled' | 'disabled' | 'archived'
      credential_ref: string | null
      credential_configured: boolean
      source: 'managed' | 'legacy-catalog'
      revision: string
      model_count: string
      profile: Record<string, unknown>
    }>(`SELECT provider.provider_key provider,provider.display_name,provider.driver,provider.protocol,
      provider.base_url,provider.auth_mode,provider.status,provider.credential_ref,provider.source,
      provider.revision::text,provider.profile,COUNT(model.id)::text model_count,
      (credential.provider_id IS NOT NULL) credential_configured
      FROM harness.model_providers provider
      LEFT JOIN harness.model_catalog model ON model.provider_id=provider.id
        AND model.organization_id=provider.organization_id
      LEFT JOIN harness.organization_model_credentials credential ON credential.provider_id=provider.id
        AND credential.organization_id=provider.organization_id
      WHERE provider.organization_id=$1
      GROUP BY provider.id,credential.provider_id
      ORDER BY provider.provider_key`, [this.context.organizationId])
    return result.rows.map(row => ({
      provider: row.provider,
      displayName: row.display_name,
      driver: row.driver,
      protocol: row.protocol,
      baseURL: row.base_url,
      authMode: row.auth_mode,
      status: row.status,
      credentialRef: row.credential_ref,
      credentialConfigured: row.credential_configured,
      source: row.source,
      revision: safeCount(row.revision, 'provider revision'),
      modelCount: safeCount(row.model_count, 'provider model count'),
      ...row.profile === undefined ? {} : { profile: row.profile },
    }))
  }

  async upsertProvider(input: ModelProviderInput): Promise<void> {
    const provider = nonEmpty(input.provider, 'provider')
    if (!ORGANIZATION_PROVIDER_PATTERN.test(provider)) {
      throw new Error(`organization provider must match ${String(ORGANIZATION_PROVIDER_PATTERN)}`)
    }
    const displayName = nonEmpty(input.displayName, 'displayName')
    if (input.driver !== 'pi-ai') throw new Error('organization provider driver must be pi-ai')
    if (!PROVIDER_PROTOCOLS.has(input.protocol)) throw new Error(`unsupported provider protocol ${input.protocol}`)
    const baseURL = providerBaseURL(input.baseURL)
    const credentialRef = input.authMode === 'api-key' ? providerCredentialRef(provider) : null
    if (input.authMode === 'none' && typeof input.credential === 'string') {
      throw new Error(`provider ${provider} does not accept an organization credential`)
    }
    await transaction(this.context.pool, async (client) => {
      const existing = await client.query<{ id: string; source: 'managed' | 'legacy-catalog'; status: string }>(`SELECT
        id,source,status FROM harness.model_providers WHERE organization_id=$1 AND provider_key=$2 FOR UPDATE`,
      [this.context.organizationId, provider])
      const current = existing.rows[0]
      if (current?.source === 'legacy-catalog') {
        throw new Error(`legacy catalog provider ${provider} cannot be managed; create an org-* provider`)
      }
      if (current?.status === 'archived' && input.status !== 'archived') {
        throw new Error(`archived provider ${provider} cannot be restored`)
      }
      const profile = {
        ...(input.profile ?? {}),
        displayName,
        api: input.protocol,
        baseURL,
        ...credentialRef === null ? {} : { apiKeyEnv: credentialRef },
      }
      const stored = await client.query<{ id: string }>(`INSERT INTO harness.model_providers(
        organization_id,provider_key,display_name,driver,protocol,base_url,auth_mode,credential_ref,status,profile
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(organization_id,provider_key) DO UPDATE SET
        display_name=excluded.display_name,driver=excluded.driver,protocol=excluded.protocol,
        base_url=excluded.base_url,auth_mode=excluded.auth_mode,credential_ref=excluded.credential_ref,
        status=excluded.status,profile=COALESCE(excluded.profile,harness.model_providers.profile),
        revision=harness.model_providers.revision+1,updated_at=now()
      RETURNING id`, [this.context.organizationId, provider, displayName, input.driver, input.protocol,
        baseURL, input.authMode, credentialRef, input.status, profile])
      const providerId = stored.rows[0]?.id
      if (providerId === undefined) throw new Error('provider upsert returned no row')
      if (input.authMode === 'none' || input.credential === null) {
        await client.query(`DELETE FROM harness.organization_model_credentials
          WHERE organization_id=$1 AND provider_id=$2`, [this.context.organizationId, providerId])
      } else if (input.credential !== undefined) {
        const encrypted = this.credentialCipher.encrypt(this.context.organizationId, providerId, input.credential)
        await client.query(`INSERT INTO harness.organization_model_credentials(
          organization_id,provider_id,key_version,nonce,ciphertext,auth_tag
        ) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider_id) DO UPDATE SET
          key_version=excluded.key_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,
          auth_tag=excluded.auth_tag,updated_at=now()`, [
          this.context.organizationId,
          providerId,
          encrypted.keyVersion,
          encrypted.nonce,
          encrypted.ciphertext,
          encrypted.authTag,
        ])
      }
      if (input.status === 'enabled') {
        const readiness = await client.query<{ models: string; credential_configured: boolean }>(`SELECT
          COUNT(model.id)::text models,
          EXISTS(SELECT 1 FROM harness.organization_model_credentials credential
            WHERE credential.organization_id=$1 AND credential.provider_id=$2) credential_configured
          FROM harness.model_catalog model WHERE model.organization_id=$1 AND model.provider_id=$2`,
        [this.context.organizationId, providerId])
        if (safeCount(readiness.rows[0]!.models, 'provider model count') === 0) {
          throw new Error(`provider ${provider} cannot be enabled without a model`)
        }
        if (input.authMode === 'api-key' && !readiness.rows[0]!.credential_configured) {
          throw new Error(`provider ${provider} cannot be enabled without an organization credential`)
        }
      }
      await this.bumpConfigurationRevision(client)
    })
  }

  /** Return the organization pi-ai namespace in the same form as settings.describe. */
  async describeOrganizationModelSettings(): Promise<OrganizationModelSettingsView> {
    const revisionResult = await this.context.pool.query<{ revision: string }>(`SELECT model_configuration_revision::text revision
      FROM harness.organizations WHERE id=$1`, [this.context.organizationId])
    const revision = safeCount(revisionResult.rows[0]?.revision ?? '0', 'organization model configuration revision')
    const profiles = await this.organizationProfiles(this.context.pool)
    return this.organizationSettingsView(profiles, revision)
  }

  /** Apply path edits from the shared Models editor and synchronize governance rows. */
  async mutateOrganizationModelSettings(
    ops: ModelSettingsPathOp[],
    expectedRevision?: number,
  ): Promise<OrganizationModelSettingsView> {
    return transaction(this.context.pool, async (client) => {
      const revisionResult = await client.query<{ revision: string }>(`SELECT model_configuration_revision::text revision
        FROM harness.organizations WHERE id=$1 FOR UPDATE`, [this.context.organizationId])
      const revision = safeCount(revisionResult.rows[0]?.revision ?? '0', 'organization model configuration revision')
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('settings-conflict')
      const current = await this.organizationProfiles(client)
      const section: Record<string, unknown> = { providers: Object.fromEntries(current) }
      for (const op of ops) {
        if (op.path.length < 2 || op.path[0] !== 'providers') throw new Error('organization settings path must address providers')
        if (op.op === 'set') setJsonPath(section, op.path, op.value)
        else unsetJsonPath(section, op.path)
      }
      const profilesObject = validateOrganizationProfiles(section)
      const profiles = new Map<string, Record<string, unknown>>(Object.entries(profilesObject))
      const existing = await client.query<{
        id: string
        provider_key: string
        status: 'draft' | 'enabled' | 'disabled' | 'archived'
        credential_ref: string | null
        profile: Record<string, unknown>
      }>(`SELECT id,provider_key,status,credential_ref,profile FROM harness.model_providers
        WHERE organization_id=$1 AND source='managed' FOR UPDATE`, [this.context.organizationId])
      const oldByProvider = new Map(existing.rows.map(row => [row.provider_key, row]))
      for (const [provider, profile] of profiles) {
        const displayName = typeof profile.displayName === 'string' && profile.displayName.trim() !== ''
          ? profile.displayName.trim()
          : provider
        const protocol = typeof profile.api === 'string' ? profile.api : null
        const baseURL = typeof profile.baseURL === 'string' ? providerBaseURL(profile.baseURL) : null
        const credentialRef = apiKeyRefOf(profile)
        const old = oldByProvider.get(provider)
        // A credential belongs to the reference named by the new profile. A
        // provider row can retain an encrypted value while its profile points
        // at a different reference, so the old row is usable only when both
        // references still match.
        const credentialConfigured = credentialRef !== undefined
          && old?.credential_ref === credentialRef
          && await this.organizationCredentialExists(client, old?.id)
        const models = profileModelsOf(profile)
        const complete = protocol !== null && baseURL !== null && models.length > 0
          && (credentialRef === undefined || credentialConfigured)
        // The shared editor owns completeness, not a second lifecycle switch.
        // A previously disabled route becomes usable once its complete profile
        // is saved; incomplete edits remain drafts.
        const status = complete ? 'enabled' : 'draft'
        const stored = await client.query<{ id: string }>(`INSERT INTO harness.model_providers(
          organization_id,provider_key,display_name,driver,protocol,base_url,auth_mode,credential_ref,status,profile
        ) VALUES($1,$2,$3,'pi-ai',$4,$5,$6,$7,$8,$9)
        ON CONFLICT(organization_id,provider_key) DO UPDATE SET
          display_name=excluded.display_name,protocol=excluded.protocol,base_url=excluded.base_url,
          auth_mode=excluded.auth_mode,credential_ref=excluded.credential_ref,status=excluded.status,
          profile=excluded.profile,revision=harness.model_providers.revision+1,updated_at=now()
        RETURNING id`, [this.context.organizationId, provider, displayName, protocol, baseURL,
          credentialRef === undefined ? 'none' : 'api-key', credentialRef, status, profile])
        const providerId = stored.rows[0]?.id
        if (providerId === undefined) throw new Error(`provider ${provider} upsert returned no row`)
        if (old?.credential_ref !== null && old?.credential_ref !== undefined && old.credential_ref !== credentialRef) {
          await client.query(`DELETE FROM harness.organization_model_credentials WHERE organization_id=$1 AND provider_id=$2`,
            [this.context.organizationId, providerId])
        }
        await this.syncProviderModels(client, providerId, provider, models)
      }
      for (const old of existing.rows) {
        if (profiles.has(old.provider_key)) continue
        await client.query(`DELETE FROM harness.organization_model_credentials
          WHERE organization_id=$1 AND provider_id=$2`, [this.context.organizationId, old.id])
        await client.query(`UPDATE harness.model_providers SET status='archived',profile='{}'::jsonb,
          revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, old.id])
        await client.query(`UPDATE harness.model_catalog SET enabled=false,updated_at=now()
          WHERE organization_id=$1 AND provider_id=$2`, [this.context.organizationId, old.id])
      }
      await this.bumpConfigurationRevision(client)
      const nextRevision = revision + 1
      return this.organizationSettingsView(profiles, nextRevision, client)
    })
  }

  /** Describe organization-owned credential state without returning values. */
  async describeOrganizationCredentials(refs: string[]): Promise<Record<string, OrganizationCredentialView>> {
    const accepted = [...new Set(refs)]
    const result = await this.context.pool.query<{ credential_ref: string }>(`SELECT provider.credential_ref
      FROM harness.model_providers provider
      JOIN harness.organization_model_credentials credential
        ON credential.organization_id=provider.organization_id AND credential.provider_id=provider.id
      WHERE provider.organization_id=$1 AND provider.source='managed' AND provider.status <> 'archived'
        AND provider.credential_ref = ANY($2::text[])`,
    [this.context.organizationId, accepted])
    const configured = new Set(result.rows.map(row => row.credential_ref))
    const rows: Record<string, OrganizationCredentialView> = {}
    for (const ref of accepted) rows[ref] = { configured: configured.has(ref), source: 'organization', writable: true }
    return rows
  }

  /** Store one encrypted organization credential and refresh provider readiness. */
  async setOrganizationCredential(ref: string, value: string): Promise<void> {
    const accepted = nonEmpty(value, 'credential')
    await transaction(this.context.pool, async (client) => {
      const provider = await this.providerForCredential(client, ref)
      if (provider === undefined) throw new Error(`unknown organization credential ${ref}`)
      const encrypted = this.credentialCipher.encrypt(this.context.organizationId, provider.id, accepted)
      await client.query(`INSERT INTO harness.organization_model_credentials(
        organization_id,provider_id,key_version,nonce,ciphertext,auth_tag
      ) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider_id) DO UPDATE SET
        key_version=excluded.key_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,updated_at=now()`, [
        this.context.organizationId, provider.id, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag,
      ])
      await this.refreshProviderReadiness(client, provider.id)
      await this.bumpConfigurationRevision(client)
    })
  }

  /** Remove one encrypted organization credential. */
  async unsetOrganizationCredential(ref: string): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const provider = await this.providerForCredential(client, ref)
      if (provider === undefined) return
      await client.query(`DELETE FROM harness.organization_model_credentials WHERE organization_id=$1 AND provider_id=$2`,
        [this.context.organizationId, provider.id])
      await this.refreshProviderReadiness(client, provider.id)
      await this.bumpConfigurationRevision(client)
    })
  }

  /** Reuse the pi-ai discovery implementation for the organization editor. */
  async discoverOrganizationModels(request: {
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }): Promise<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>> {
    return discoverOrganizationModels(request)
  }

  async listModels(): Promise<ModelRow[]> {
    const result = await this.context.pool.query<{
      provider: string
      model: string
      display_name: string
      enabled: boolean
      admin_allowed: boolean
      user_allowed: boolean
      input_price: string
      output_price: string
      cache_read_price: string
      cache_write_price: string
    }>(`SELECT m.provider_key provider,m.model_key model,m.display_name,m.enabled,
      COALESCE(a.allowed,true) admin_allowed,COALESCE(u.allowed,false) user_allowed,
      COALESCE(p.input_per_million,0)::text input_price,
      COALESCE(p.output_per_million,0)::text output_price,
      COALESCE(p.cache_read_per_million,0)::text cache_read_price,
      COALESCE(p.cache_write_per_million,0)::text cache_write_price
      FROM harness.model_catalog m
      JOIN harness.model_providers provider ON provider.id=m.provider_id
        AND provider.organization_id=m.organization_id
      LEFT JOIN harness.model_role_access a ON a.organization_id=m.organization_id
        AND a.model_id=m.id AND a.role='admin'
      LEFT JOIN harness.model_role_access u ON u.organization_id=m.organization_id
        AND u.model_id=m.id AND u.role='member'
      LEFT JOIN LATERAL (SELECT * FROM harness.model_prices p
        WHERE p.model_id=m.id ORDER BY p.effective_at DESC,p.id DESC LIMIT 1) p ON true
      WHERE m.organization_id=$1 AND provider.source='managed' AND provider.status <> 'archived'
      ORDER BY m.provider_key,m.model_key`, [this.context.organizationId])
    return result.rows.map(row => ({
      provider: row.provider,
      model: row.model,
      displayName: row.display_name,
      enabled: row.enabled,
      adminAllowed: row.admin_allowed,
      userAllowed: row.user_allowed,
      inputMicrosPerMillion: decimalToMicros(row.input_price),
      outputMicrosPerMillion: decimalToMicros(row.output_price),
      cacheReadMicrosPerMillion: decimalToMicros(row.cache_read_price),
      cacheWriteMicrosPerMillion: decimalToMicros(row.cache_write_price),
    }))
  }

  async upsertModel(input: Omit<ModelRow, 'adminAllowed' | 'userAllowed'> & {
    adminAllowed?: boolean
    userAllowed?: boolean
  }): Promise<void> {
    const provider = nonEmpty(input.provider, 'provider')
    const model = nonEmpty(input.model, 'model')
    const prices = [
      input.inputMicrosPerMillion,
      input.outputMicrosPerMillion,
      input.cacheReadMicrosPerMillion,
      input.cacheWriteMicrosPerMillion,
    ].map((value, index) => microsToDecimal(nonnegative(value, `price[${String(index)}]`)))
    await transaction(this.context.pool, async (client) => {
      const providerRow = await client.query<{ id: string; source: string; status: string }>(`SELECT id,source,status
        FROM harness.model_providers WHERE organization_id=$1 AND provider_key=$2 FOR UPDATE`,
      [this.context.organizationId, provider])
      const configuredProvider = providerRow.rows[0]
      if (configuredProvider === undefined) throw new Error(`unknown provider ${provider}`)
      if (configuredProvider.source !== 'managed') {
        throw new Error(`legacy catalog provider ${provider} cannot accept model changes`)
      }
      if (configuredProvider.status === 'archived') throw new Error(`provider ${provider} is archived`)
      const catalog = await client.query<{ id: string }>(`INSERT INTO harness.model_catalog(
        organization_id,provider_id,provider_key,model_key,display_name,enabled
      ) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,provider_key,model_key) DO UPDATE SET
        display_name=excluded.display_name,enabled=excluded.enabled,updated_at=now() RETURNING id`,
      [this.context.organizationId, configuredProvider.id, provider, model,
        nonEmpty(input.displayName, 'displayName'), input.enabled])
      const modelId = catalog.rows[0]?.id
      if (modelId === undefined) throw new Error('model upsert returned no row')
      for (const [role, allowed] of [
        ['admin', input.adminAllowed ?? true],
        ['member', input.userAllowed ?? false],
      ] as const) {
        await client.query(`INSERT INTO harness.model_role_access(organization_id,role,model_id,allowed)
          VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,role,model_id) DO UPDATE SET allowed=excluded.allowed`,
        [this.context.organizationId, role, modelId, allowed])
      }
      const latest = await client.query<{ effective_at: Date }>(`SELECT GREATEST(
        clock_timestamp(),COALESCE(MAX(effective_at)+interval '1 microsecond',clock_timestamp())
      ) effective_at FROM harness.model_prices WHERE model_id=$1`, [modelId])
      await client.query(`INSERT INTO harness.model_prices(model_id,effective_at,input_per_million,
        output_per_million,cache_read_per_million,cache_write_per_million)
        VALUES($1,$2,$3,$4,$5,$6)`, [modelId, latest.rows[0]!.effective_at, ...prices])
      await client.query(`UPDATE harness.model_providers SET revision=revision+1,updated_at=now()
        WHERE id=$1 AND organization_id=$2`, [configuredProvider.id, this.context.organizationId])
      await this.bumpConfigurationRevision(client)
    })
  }

  async setUserAccess(userId: number, provider: string, model: string, allowed: boolean | null): Promise<void> {
    provider = nonEmpty(provider, 'provider')
    model = nonEmpty(model, 'model')
    await transaction(this.context.pool, async (client) => {
      const user = await internalUserId(client, this.context.organizationId, userId)
      if (user === null) throw new Error(`unknown user ${String(userId)}`)
      const catalog = await client.query<{ id: string }>(`SELECT model.id FROM harness.model_catalog model
        JOIN harness.model_providers provider ON provider.id=model.provider_id
          AND provider.organization_id=model.organization_id
        WHERE model.organization_id=$1 AND model.provider_key=$2 AND model.model_key=$3
          AND provider.source='managed' AND provider.status <> 'archived'`,
      [this.context.organizationId, provider, model])
      const modelId = catalog.rows[0]?.id
      if (modelId === undefined) throw new Error(`unknown model ${provider}/${model}`)
      if (allowed === null) {
        await client.query('DELETE FROM harness.model_user_access WHERE user_id=$1 AND model_id=$2', [user, modelId])
      } else {
        await client.query(`INSERT INTO harness.model_user_access(organization_id,user_id,model_id,allowed)
          VALUES($1,$2,$3,$4) ON CONFLICT(user_id,model_id) DO UPDATE SET allowed=excluded.allowed`,
        [this.context.organizationId, user, modelId, allowed])
      }
      await this.bumpConfigurationRevision(client)
    })
  }

  async userOverrides(userId: number): Promise<Array<{ provider: string; model: string; allowed: boolean }>> {
    const result = await this.context.pool.query<{ provider: string; model: string; allowed: boolean }>(`SELECT
      m.provider_key provider,m.model_key model,x.allowed
      FROM harness.model_user_access x
      JOIN harness.users u ON u.id=x.user_id AND u.organization_id=x.organization_id
      JOIN harness.model_catalog m ON m.id=x.model_id AND m.organization_id=x.organization_id
      WHERE x.organization_id=$1 AND u.public_id=$2 ORDER BY m.provider_key,m.model_key`,
    [this.context.organizationId, userId])
    return result.rows
  }

  async setProjectAccess(
    projectId: number,
    provider: string,
    model: string,
    allowed: boolean | null,
  ): Promise<void> {
    provider = nonEmpty(provider, 'provider')
    model = nonEmpty(model, 'model')
    await transaction(this.context.pool, async (client) => {
      const project = await internalProjectId(client, this.context.organizationId, projectId)
      if (project === null) throw new Error(`unknown project ${String(projectId)}`)
      const catalog = await client.query<{ id: string }>(`SELECT model.id FROM harness.model_catalog model
        JOIN harness.model_providers provider ON provider.id=model.provider_id
          AND provider.organization_id=model.organization_id
        WHERE model.organization_id=$1 AND model.provider_key=$2 AND model.model_key=$3
          AND provider.source='managed' AND provider.status <> 'archived'`,
      [this.context.organizationId, provider, model])
      const modelId = catalog.rows[0]?.id
      if (modelId === undefined) throw new Error(`unknown model ${provider}/${model}`)
      if (allowed === null) {
        await client.query('DELETE FROM harness.model_project_access WHERE project_id=$1 AND model_id=$2',
          [project, modelId])
      } else {
        await client.query(`INSERT INTO harness.model_project_access(
          organization_id,project_id,model_id,allowed
        ) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,model_id) DO UPDATE SET
          allowed=excluded.allowed,updated_at=now()`, [this.context.organizationId, project, modelId, allowed])
      }
      await this.bumpConfigurationRevision(client)
    })
  }

  async setAllProjectAccess(projectId: number, allowed: true | null): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const project = await internalProjectId(client, this.context.organizationId, projectId)
      if (project === null) throw new Error(`unknown project ${String(projectId)}`)
      await client.query(`UPDATE harness.projects
        SET model_access_default_allowed=$3,updated_at=now()
        WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, project, allowed === true])
      // The default is authoritative for every unlisted model. Clearing explicit
      // rows keeps the mode unambiguous and lets newly added catalog entries follow it.
      await client.query(
        'DELETE FROM harness.model_project_access WHERE organization_id=$1 AND project_id=$2',
        [this.context.organizationId, project],
      )
      await this.bumpConfigurationRevision(client)
    })
  }

  async projectOverrides(projectId: number): Promise<Array<{ provider: string; model: string; allowed: boolean }>> {
    const project = await internalProjectId(this.context.pool, this.context.organizationId, projectId)
    if (project === null) throw new Error(`unknown project ${String(projectId)}`)
    const result = await this.context.pool.query<{ provider: string; model: string; allowed: boolean }>(`SELECT
      model.provider_key provider,model.model_key model,access.allowed
      FROM harness.model_project_access access
      JOIN harness.model_catalog model ON model.id=access.model_id AND model.organization_id=access.organization_id
      WHERE access.organization_id=$1 AND access.project_id=$2 ORDER BY model.provider_key,model.model_key`,
    [this.context.organizationId, project])
    return result.rows
  }

  async policyFor(user: UserRow): Promise<RuntimeModelPolicy> {
    return transaction(this.context.pool, async (client) => {
      const version = await this.lockConfigurationRevision(client)
      const result = await client.query<{
        provider: string
        model: string
        provider_enabled: boolean
        model_enabled: boolean
        allowed: boolean
      }>(`SELECT model.provider_key provider,model.model_key model,
        (provider.status='enabled') provider_enabled,model.enabled model_enabled,
        COALESCE(access.allowed,role_access.allowed,$3::boolean) allowed
        FROM harness.model_catalog model
        JOIN harness.model_providers provider ON provider.id=model.provider_id
          AND provider.organization_id=model.organization_id
        LEFT JOIN harness.model_role_access role_access ON role_access.organization_id=model.organization_id
          AND role_access.model_id=model.id AND role_access.role=$4
        LEFT JOIN harness.users target ON target.organization_id=model.organization_id AND target.public_id=$2
        LEFT JOIN harness.model_user_access access ON access.organization_id=model.organization_id
          AND access.model_id=model.id AND access.user_id=target.id
        WHERE model.organization_id=$1 AND provider.source='managed' AND provider.status <> 'archived'
        ORDER BY model.provider_key,model.model_key`,
      [this.context.organizationId, user.id, user.role === 'admin', roleForPostgres(user.role)])
      return {
        version,
        defaultAllowed: false,
        models: result.rows.map(row => ({
          provider: row.provider,
          model: row.model,
          allowed: row.provider_enabled && row.model_enabled && row.allowed,
        })),
        providers: await this.runtimeProviders(client),
      }
    })
  }

  async policyForProject(projectId: number): Promise<RuntimeModelPolicy> {
    return transaction(this.context.pool, async (client) => {
      const project = await internalProjectId(client, this.context.organizationId, projectId)
      if (project === null) throw new Error(`unknown project ${String(projectId)}`)
      const version = await this.lockConfigurationRevision(client)
      const result = await client.query<{
        provider: string
        model: string
        provider_enabled: boolean
        model_enabled: boolean
        allowed: boolean
      }>(`SELECT model.provider_key provider,model.model_key model,
        (provider.status='enabled') provider_enabled,model.enabled model_enabled,
        COALESCE(access.allowed,project.model_access_default_allowed) allowed
        FROM harness.model_catalog model
        JOIN harness.model_providers provider ON provider.id=model.provider_id
          AND provider.organization_id=model.organization_id
        JOIN harness.projects project ON project.id=$2 AND project.organization_id=model.organization_id
        LEFT JOIN harness.model_project_access access ON access.organization_id=model.organization_id
          AND access.model_id=model.id AND access.project_id=$2
        WHERE model.organization_id=$1 AND provider.source='managed' AND provider.status <> 'archived'
        ORDER BY model.provider_key,model.model_key`,
      [this.context.organizationId, project])
      return {
        version,
        defaultAllowed: false,
        models: result.rows.map(row => ({
          provider: row.provider,
          model: row.model,
          allowed: row.provider_enabled && row.model_enabled && row.allowed,
        })),
        providers: await this.runtimeProviders(client),
      }
    })
  }

  async resolveOrganizationCredential(subject: ModelUsageSubject, ref: string): Promise<string | null> {
    const subjectId = subject.kind === 'user'
      ? await internalUserId(this.context.pool, this.context.organizationId, subject.id)
      : await internalProjectId(this.context.pool, this.context.organizationId, subject.id)
    if (subjectId === null) return null
    const authorization = subject.kind === 'user'
      ? `EXISTS(SELECT 1 FROM harness.model_catalog model
          JOIN harness.users target ON target.organization_id=model.organization_id AND target.id=$3
          JOIN harness.memberships membership ON membership.organization_id=target.organization_id
            AND membership.user_id=target.id AND membership.status='active'
          LEFT JOIN harness.model_role_access role_access ON role_access.organization_id=model.organization_id
            AND role_access.model_id=model.id AND role_access.role=membership.role
          LEFT JOIN harness.model_user_access user_access ON user_access.organization_id=model.organization_id
            AND user_access.model_id=model.id AND user_access.user_id=target.id
          WHERE model.organization_id=provider.organization_id AND model.provider_id=provider.id
            AND provider.source='managed' AND provider.status <> 'archived'
            AND model.enabled AND COALESCE(user_access.allowed,role_access.allowed,membership.role='admin'))`
      : `EXISTS(SELECT 1 FROM harness.model_catalog model
          JOIN harness.projects project ON project.id=$3 AND project.organization_id=model.organization_id
          LEFT JOIN harness.model_project_access access ON access.organization_id=model.organization_id
            AND access.model_id=model.id AND access.project_id=project.id
          WHERE model.organization_id=provider.organization_id AND model.provider_id=provider.id
            AND provider.source='managed' AND provider.status <> 'archived'
            AND model.enabled AND COALESCE(access.allowed,project.model_access_default_allowed))`
    const result = await this.context.pool.query<{
      provider_id: string
      key_version: number
      nonce: Buffer
      ciphertext: Buffer
      auth_tag: Buffer
    }>(`SELECT provider.id provider_id,credential.key_version,credential.nonce,
      credential.ciphertext,credential.auth_tag
      FROM harness.model_providers provider
      JOIN harness.organization_model_credentials credential ON credential.organization_id=provider.organization_id
        AND credential.provider_id=provider.id
      WHERE provider.organization_id=$1 AND provider.credential_ref=$2
        AND provider.source='managed' AND provider.status='enabled' AND ${authorization}
      LIMIT 1`, [this.context.organizationId, ref, subjectId])
    const row = result.rows[0]
    if (row === undefined) return null
    return this.credentialCipher.decrypt(this.context.organizationId, row.provider_id, {
      keyVersion: row.key_version as 1,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.auth_tag,
    })
  }

  async issueIntakeToken(subject: ModelUsageSubject): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    if (subject.kind === 'user') {
      const user = await internalUserId(this.context.pool, this.context.organizationId, subject.id)
      if (user === null) throw new Error(`unknown user ${String(subject.id)}`)
      await this.context.pool.query(`INSERT INTO harness.model_intake_tokens(user_id,token_hash)
        VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=now()`,
      [user, tokenHash(token)])
    } else {
      const project = await internalProjectId(this.context.pool, this.context.organizationId, subject.id)
      if (project === null) throw new Error(`unknown project ${String(subject.id)}`)
      await this.context.pool.query(`INSERT INTO harness.project_model_intake_tokens(project_id,token_hash)
        VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=now()`,
      [project, tokenHash(token)])
    }
    return token
  }

  async subjectForIntakeToken(token: string): Promise<ModelUsageSubject | null> {
    const result = await this.context.pool.query<{ kind: 'user' | 'project'; public_id: string }>(`SELECT
      'user'::text kind,u.public_id::text public_id
      FROM harness.model_intake_tokens t
      JOIN harness.users u ON u.id=t.user_id
      WHERE u.organization_id=$1 AND t.token_hash=$2
      UNION ALL
      SELECT 'project'::text kind,p.public_id::text public_id
      FROM harness.project_model_intake_tokens t
      JOIN harness.projects p ON p.id=t.project_id
      WHERE p.organization_id=$1 AND t.token_hash=$2`, [this.context.organizationId, tokenHash(token)])
    if (result.rows.length > 1) throw new Error('model intake token resolves more than one subject')
    const row = result.rows[0]
    return row === undefined ? null : { kind: row.kind, id: safeCount(row.public_id, `${row.kind} id`) }
  }

  async setQuota(
    subjectType: 'role' | 'user' | 'project',
    subjectId: string,
    tokenLimit: number | null | 'inherit',
    costLimit: number | null | 'inherit',
  ): Promise<void> {
    subjectId = nonEmpty(subjectId, 'subjectId')
    if (subjectType === 'role') {
      if (subjectId !== 'admin' && subjectId !== 'user') throw new Error('role quota subject must be admin or user')
      if (tokenLimit === 'inherit' || costLimit === 'inherit') throw new Error('role quotas cannot inherit')
      await this.context.pool.query(`INSERT INTO harness.role_quotas(
        organization_id,role,token_limit,company_cost_limit
      ) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,role) DO UPDATE SET
        token_limit=excluded.token_limit,company_cost_limit=excluded.company_cost_limit`, [
        this.context.organizationId,
        roleForPostgres(subjectId),
        tokenLimit === null ? null : nonnegative(tokenLimit, 'tokenLimit'),
        costLimit === null ? null : microsToDecimal(nonnegative(costLimit, 'companyCostMicrosLimit')),
      ])
      return
    }
    const publicId = Number(subjectId)
    if (!Number.isSafeInteger(publicId) || publicId <= 0) {
      throw new Error(`${subjectType} quota subject must be a positive ${subjectType} id`)
    }
    if (subjectType === 'project') {
      const project = await internalProjectId(this.context.pool, this.context.organizationId, publicId)
      if (project === null) throw new Error(`unknown project ${subjectId}`)
      if (tokenLimit === 'inherit' && costLimit === 'inherit') {
        await this.context.pool.query('DELETE FROM harness.project_quotas WHERE project_id=$1', [project])
        return
      }
      if (tokenLimit === 'inherit' || costLimit === 'inherit') {
        throw new Error('project quota fields must both inherit or both be explicit')
      }
      await this.context.pool.query(`INSERT INTO harness.project_quotas(
        project_id,token_limit,company_cost_limit
      ) VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET
        token_limit=excluded.token_limit,company_cost_limit=excluded.company_cost_limit`, [
        project,
        tokenLimit === null ? null : nonnegative(tokenLimit, 'tokenLimit'),
        costLimit === null ? null : microsToDecimal(nonnegative(costLimit, 'companyCostMicrosLimit')),
      ])
      return
    }
    const user = await internalUserId(this.context.pool, this.context.organizationId, publicId)
    if (user === null) throw new Error(`unknown user ${subjectId}`)
    if (tokenLimit === 'inherit' && costLimit === 'inherit') {
      await this.context.pool.query('DELETE FROM harness.user_quotas WHERE user_id=$1', [user])
      return
    }
    const tokenMode = tokenLimit === 'inherit' ? 'inherit' : tokenLimit === null ? 'unlimited' : 'custom'
    const costMode = costLimit === 'inherit' ? 'inherit' : costLimit === null ? 'unlimited' : 'custom'
    await this.context.pool.query(`INSERT INTO harness.user_quotas(
      user_id,token_mode,token_limit,company_cost_mode,company_cost_limit
    ) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET
      token_mode=excluded.token_mode,token_limit=excluded.token_limit,
      company_cost_mode=excluded.company_cost_mode,company_cost_limit=excluded.company_cost_limit`, [
      user,
      tokenMode,
      typeof tokenLimit === 'number' ? nonnegative(tokenLimit, 'tokenLimit') : null,
      costMode,
      typeof costLimit === 'number' ? microsToDecimal(nonnegative(costLimit, 'companyCostMicrosLimit')) : null,
    ])
  }

  async projectQuota(projectId: number): Promise<ProjectQuotaView> {
    const project = await internalProjectId(this.context.pool, this.context.organizationId, projectId)
    if (project === null) throw new Error(`unknown project ${String(projectId)}`)
    const quota = await this.context.pool.query<{ token_limit: string | null; company_cost_limit: string | null }>(`SELECT
      token_limit::text,company_cost_limit::text FROM harness.project_quotas WHERE project_id=$1`, [project])
    const projectLimits = quota.rows[0]
    if (projectLimits !== undefined) {
      return {
        source: 'independent',
        tokenLimit: projectLimits.token_limit === null ? null : safeCount(projectLimits.token_limit, 'project token limit'),
        companyCostMicrosLimit: projectLimits.company_cost_limit === null
          ? null
          : decimalToMicros(projectLimits.company_cost_limit),
      }
    }
    const inherited = await this.context.pool.query<{ token_limit: string | null; company_cost_limit: string | null }>(`SELECT
      token_limit::text,company_cost_limit::text FROM harness.role_quotas
      WHERE organization_id=$1 AND role='member'`, [this.context.organizationId])
    const limits = inherited.rows[0]
    return {
      source: 'inherit',
      tokenLimit: limits?.token_limit === null || limits?.token_limit === undefined
        ? null
        : safeCount(limits.token_limit, 'project token limit'),
      companyCostMicrosLimit: limits?.company_cost_limit === null || limits?.company_cost_limit === undefined
        ? null
        : decimalToMicros(limits.company_cost_limit),
    }
  }

  async ingest(subject: ModelUsageSubject, event: UsageEvent): Promise<{ inserted: boolean; alerts: number }> {
    if (event === null || typeof event !== 'object') throw new Error('usage event must be an object')
    nonEmpty(event.eventId, 'eventId')
    if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) {
      throw new Error('occurredAt must be a non-negative safe integer')
    }
    if (event.actorUserId !== undefined && (!Number.isSafeInteger(event.actorUserId) || event.actorUserId <= 0)) {
      throw new Error('actorUserId must be a positive safe integer')
    }
    if (event.actorProjectId !== undefined && (!Number.isSafeInteger(event.actorProjectId) || event.actorProjectId <= 0)) {
      throw new Error('actorProjectId must be a positive safe integer')
    }
    if (event.actorProjectId !== undefined && event.actorUserId === undefined) {
      throw new Error('actorProjectId requires actorUserId')
    }
    if (!['company', 'personal', 'unknown'].includes(event.credentialClass)) throw new Error('invalid credentialClass')
    if (!['succeeded', 'failed', 'cancelled', 'missing-usage', 'denied'].includes(event.status)) {
      throw new Error('invalid status')
    }
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
    const provider = nonEmpty(event.provider, 'provider')
    const model = nonEmpty(event.model, 'model')
    return transaction(this.context.pool, async (client) => {
      const user = subject.kind === 'user'
        ? await internalUserId(client, this.context.organizationId, subject.id)
        : null
      const project = subject.kind === 'project'
        ? await internalProjectId(client, this.context.organizationId, subject.id)
        : null
      if (subject.kind === 'user' && user === null) throw new Error(`unknown user ${String(subject.id)}`)
      if (subject.kind === 'project' && project === null) throw new Error(`unknown project ${String(subject.id)}`)
      // Actor attribution is an activity projection for shared projects only;
      // personal billing rows must not duplicate their billing user here.
      let actor: string | null = null
      if (subject.kind === 'project') {
        if (event.actorProjectId !== undefined && event.actorProjectId !== subject.id) {
          throw new Error('actorProjectId must match the project usage subject')
        }
        if (event.actorUserId !== undefined) {
          actor = await internalUserId(client, this.context.organizationId, event.actorUserId)
          if (actor === null) throw new Error(`unknown usage actor ${String(event.actorUserId)}`)
          const member = await client.query<{ allowed: boolean }>(`SELECT EXISTS(
            SELECT 1 FROM harness.users u
            JOIN harness.memberships membership ON membership.organization_id=u.organization_id
              AND membership.user_id=u.id AND membership.status='active'
            LEFT JOIN harness.project_members member ON member.organization_id=u.organization_id
              AND member.project_id=$2 AND member.user_id=u.id
            WHERE u.organization_id=$1 AND u.id=$3 AND u.status='active'
              AND (membership.role='admin' OR member.access_mode='rw')
          ) allowed`, [this.context.organizationId, project, actor])
          if (member.rows[0]?.allowed !== true) throw new Error(`usage actor ${String(event.actorUserId)} is not an active project writer`)
        }
      } else {
        if (event.actorUserId !== undefined && event.actorUserId !== subject.id) {
          throw new Error('actorUserId must match the personal usage subject')
        }
        if (event.actorProjectId !== undefined) {
          throw new Error('actorProjectId is not valid for personal usage')
        }
      }
      const catalog = await client.query<{
        id: string
        input_price: string | null
        output_price: string | null
        cache_read_price: string | null
        cache_write_price: string | null
      }>(`SELECT m.id,p.input_per_million::text input_price,p.output_per_million::text output_price,
        p.cache_read_per_million::text cache_read_price,p.cache_write_per_million::text cache_write_price
        FROM harness.model_catalog m LEFT JOIN LATERAL (
          SELECT * FROM harness.model_prices p WHERE p.model_id=m.id
            AND p.effective_at<=to_timestamp($4/1000.0)
          ORDER BY p.effective_at DESC,p.id DESC LIMIT 1
        ) p ON true WHERE m.organization_id=$1 AND m.provider_key=$2 AND m.model_key=$3`,
      [this.context.organizationId, provider, model, event.occurredAt])
      const price = catalog.rows[0]
      const priceValues = [price?.input_price, price?.output_price, price?.cache_read_price, price?.cache_write_price]
      const pricingStatus = price === undefined || price.input_price === null
        ? 'unpriced'
        : priceValues.every(value => decimalToMicros(value ?? '0') === 0) ? 'configured-zero' : 'priced'
      const estimated = price?.input_price === null || price?.input_price === undefined ? 0 : Math.round((
        buckets.input * decimalToMicros(price.input_price)
        + buckets.output * decimalToMicros(price.output_price ?? '0')
        + buckets.read * decimalToMicros(price.cache_read_price ?? '0')
        + buckets.write * decimalToMicros(price.cache_write_price ?? '0')
      ) / 1_000_000)
      const companyCost = credentialClass === 'personal' ? 0 : estimated
      const inserted = await client.query<{ event_id: string }>(`INSERT INTO harness.model_usage(
        event_id,organization_id,user_id,project_id,actor_user_id,pricing_status,occurred_at,received_at,model_id,provider_key,model_key,purpose,
        session_id,credential_source,credential_class,status,input_tokens,output_tokens,cache_read_tokens,
        cache_write_tokens,estimated_cost,company_cost
      ) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),now(),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT(organization_id,event_id) DO NOTHING RETURNING event_id`, [
        event.eventId,
        this.context.organizationId,
        user,
        project,
        actor,
        pricingStatus,
        event.occurredAt,
        price?.id ?? null,
        provider,
        model,
        nonEmpty(event.purpose, 'purpose'),
        event.sessionId ?? null,
        event.credentialSource,
        credentialClass,
        event.status,
        buckets.input,
        buckets.output,
        buckets.read,
        buckets.write,
        microsToDecimal(estimated),
        microsToDecimal(companyCost),
      ])
      if (inserted.rows.length === 0) return { inserted: false, alerts: 0 }
      return {
        inserted: true,
        alerts: await this.evaluateAlerts(client, subject, monthOf(event.occurredAt, this.timeZone)),
      }
    })
  }

  async ingestRegistration(subject: ModelUsageSubject, event: ModelRegistrationEvent): Promise<{ inserted: boolean }> {
    if (subject.kind !== 'user') throw new Error('model registration events require a personal user runtime')
    if (event === null || typeof event !== 'object' || event.kind !== 'model-registration') {
      throw new Error('model registration event must have kind model-registration')
    }
    nonEmpty(event.eventId, 'eventId')
    if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) {
      throw new Error('occurredAt must be a non-negative safe integer')
    }
    const actions: ModelRegistrationEvent['action'][] = [
      'provider-created', 'provider-modified', 'provider-deleted',
      'model-created', 'model-modified', 'model-deleted',
    ]
    if (!actions.includes(event.action)) throw new Error('invalid model registration action')
    if (event.scope !== 'personal') throw new Error('model registration scope must be personal')
    const provider = nonEmpty(event.provider, 'provider')
    const modelAction = event.action.startsWith('model-')
    const model = modelAction ? nonEmpty(event.model ?? '', 'model') : null
    if (!modelAction && event.model !== undefined) throw new Error('provider registration events cannot name a model')
    const user = await internalUserId(this.context.pool, this.context.organizationId, subject.id)
    if (user === null) throw new Error(`unknown user ${String(subject.id)}`)
    const inserted = await this.context.pool.query<{ event_id: string }>(`INSERT INTO harness.model_registration_events(
      event_id,organization_id,user_id,occurred_at,received_at,provider_key,model_key,action,scope
    ) VALUES($1,$2,$3,to_timestamp($4/1000.0),now(),$5,$6,$7,$8)
      ON CONFLICT(organization_id,event_id) DO NOTHING RETURNING event_id`, [
      event.eventId, this.context.organizationId, user, event.occurredAt, provider, model, event.action, event.scope,
    ])
    return { inserted: inserted.rows.length !== 0 }
  }

  async registrationReport(filter: ModelRegistrationFilter = {}): Promise<ModelRegistrationReport> {
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 100
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('registration offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('registration limit must be from 1 through 500')
    const values: unknown[] = [this.context.organizationId]
    const clauses = ['e.organization_id=$1']
    const add = (sql: string, value: unknown): void => { values.push(value); clauses.push(sql.replace('?', `$${String(values.length)}`)) }
    if (filter.userId !== undefined) {
      if (!Number.isSafeInteger(filter.userId) || filter.userId <= 0) throw new Error('userId must be a positive safe integer')
      add('u.public_id=?', filter.userId)
    }
    if (filter.provider !== undefined) add('e.provider_key=?', nonEmpty(filter.provider, 'provider'))
    if (filter.model !== undefined) add('e.model_key=?', nonEmpty(filter.model, 'model'))
    if (filter.action !== undefined) {
      const actions: readonly ModelRegistrationEvent['action'][] = [
        'provider-created', 'provider-modified', 'provider-deleted',
        'model-created', 'model-modified', 'model-deleted',
      ]
      if (!actions.includes(filter.action)) throw new Error('invalid model registration action')
      add('e.action=?', filter.action)
    }
    if (filter.fromMs !== undefined) {
      if (!Number.isSafeInteger(filter.fromMs) || filter.fromMs < 0) throw new Error('fromMs must be a non-negative safe integer')
      add('e.occurred_at>=to_timestamp(?/1000.0)', filter.fromMs)
    }
    if (filter.toMs !== undefined) {
      if (!Number.isSafeInteger(filter.toMs) || filter.toMs < 0) throw new Error('toMs must be a non-negative safe integer')
      add('e.occurred_at<to_timestamp(?/1000.0)', filter.toMs)
    }
    const result = await this.context.pool.query<{
      event_id: string; user_id: string; occurred_at: Date; received_at: Date; provider_key: string;
      model_key: string | null; action: ModelRegistrationEvent['action']; scope: 'personal'
    }>(`SELECT e.event_id,u.public_id::text user_id,e.occurred_at,e.received_at,e.provider_key,e.model_key,e.action,e.scope
      FROM harness.model_registration_events e JOIN harness.users u
        ON u.id=e.user_id AND u.organization_id=e.organization_id
      WHERE ${clauses.join(' AND ')} ORDER BY e.occurred_at DESC,e.event_id DESC`, values)
    const all: ModelRegistrationRow[] = result.rows.map(row => ({
      eventId: row.event_id, userId: safeCount(row.user_id, 'user id'), occurredAt: row.occurred_at.getTime(),
      receivedAt: row.received_at.getTime(), provider: row.provider_key, model: row.model_key,
      action: row.action, scope: row.scope,
    }))
    const providerState = new Map<string, ModelRegistrationEvent['action']>()
    const modelState = new Map<string, ModelRegistrationEvent['action']>()
    for (const row of [...all].sort((a, b) => a.occurredAt - b.occurredAt
      || a.receivedAt - b.receivedAt || a.eventId.localeCompare(b.eventId))) {
      if (row.model === null) providerState.set(`${row.userId}\0${row.provider}`, row.action)
      else modelState.set(`${row.userId}\0${row.provider}\0${row.model}`, row.action)
    }
    for (const [key, action] of modelState) {
      if (action === 'model-deleted') continue
      const providerKey = key.slice(0, key.lastIndexOf('\0'))
      if (!providerState.has(providerKey)) providerState.set(providerKey, 'provider-created')
    }
    const actionCount = (prefix: string): number => all.filter(row => row.action.startsWith(prefix)).length
    return {
      summary: {
        providerCount: [...providerState.values()].filter(action => action !== 'provider-deleted').length,
        modelCount: [...modelState.values()].filter(action => action !== 'model-deleted').length,
        eventCount: all.length,
        createdCount: actionCount('provider-created') + actionCount('model-created'),
        modifiedCount: actionCount('provider-modified') + actionCount('model-modified'),
        deletedCount: actionCount('provider-deleted') + actionCount('model-deleted'),
      },
      rows: all.slice(offset, offset + limit),
    }
  }

  async summary(subject: ModelUsageSubject, month = monthOf(Date.now(), this.timeZone)): Promise<UsageSummary> {
    return this.summaryWith(this.context.pool, subject, month)
  }

  /**
   * Summarize confirmed project actors without changing project billing totals.
   * @param month - natural month in the configured usage time zone.
   * @param projectId - optional public project filter.
   * @returns contributor rows and project calls without a confirmed actor.
   */
  async usageContributors(month = monthOf(Date.now(), this.timeZone), projectId?: number): Promise<UsageContributorReport> {
    const project = projectId === undefined
      ? undefined
      : await internalProjectId(this.context.pool, this.context.organizationId, projectId)
    if (projectId !== undefined && project === null) throw new Error(`unknown project ${String(projectId)}`)
    const projectInternalId = project ?? undefined
    const rows = await this.contributorRows(this.context.pool, month, projectInternalId)
    const unattributed = await this.usageTotalsWhere(
      this.context.pool,
      projectInternalId === undefined ? 'project_id IS NOT NULL AND actor_user_id IS NULL' : 'project_id=$2 AND actor_user_id IS NULL',
      projectInternalId === undefined ? [] : [projectInternalId],
      month,
    )
    return {
      month,
      timeZone: this.timeZone,
      ...(projectId === undefined ? {} : { projectId }),
      rows,
      unattributed: usageMeasure(unattributed),
    }
  }

  /**
   * Build the administrator overview for personal, project, and contributor usage.
   * @param month - natural month in the configured usage time zone.
   * @returns non-overlapping billing totals plus activity projections.
   */
  async usageOverview(month = monthOf(Date.now(), this.timeZone)): Promise<UsageOverview> {
    const users = await this.context.pool.query<{ public_id: string; username: string; archived: boolean }>(`SELECT
      u.public_id::text,u.username::text,
      (u.deleted_at IS NOT NULL OR u.status <> 'active' OR COALESCE(membership.status <> 'active', true)) archived
      FROM harness.users u LEFT JOIN harness.memberships membership
        ON membership.organization_id=u.organization_id AND membership.user_id=u.id
      WHERE u.organization_id=$1
      ORDER BY u.public_id`, [this.context.organizationId])
    const [personal, projects, unattributed, contributors] = await Promise.all([
      this.usageTotalsWhere(this.context.pool, 'user_id IS NOT NULL', [], month),
      this.usageTotalsWhere(this.context.pool, 'project_id IS NOT NULL', [], month),
      this.usageTotalsWhere(this.context.pool, 'project_id IS NOT NULL AND actor_user_id IS NULL', [], month),
      this.contributorRows(this.context.pool, month),
    ])
    const contributions = new Map(contributors.map(row => [row.userId, row]))
    const userRows = await Promise.all(users.rows.map(async user => {
      const userId = safeCount(user.public_id, 'user id')
      return {
        userId,
        username: user.username,
        archived: user.archived,
        personal: await this.userSummaryWith(this.context.pool, userId, month),
        projectContribution: contributions.get(userId) ?? zeroUsageMeasure(),
      }
    }))
    return {
      month,
      timeZone: this.timeZone,
      personal: usageMeasure(personal),
      projects: usageMeasure(projects),
      unattributedProjects: usageMeasure(unattributed),
      users: userRows,
    }
  }

  /**
   * Check ingestion and attribution coverage for one natural month.
   * @param month - natural month in the configured usage time zone.
   * @returns health counters suitable for an administrator diagnostic view.
   */
  async usageHealth(month = monthOf(Date.now(), this.timeZone)): Promise<UsageHealth> {
    const { start, end } = monthBounds(month, this.timeZone)
    const result = await this.context.pool.query<{
      missing: string
      unattributed_calls: string
      unattributed_tokens: string
      unpriced: string
      historical_unknown: string
      max_lag_ms: string | null
    }>(`SELECT COUNT(*) FILTER (WHERE status='missing-usage')::text missing,
      COUNT(*) FILTER (WHERE project_id IS NOT NULL AND actor_user_id IS NULL)::text unattributed_calls,
      COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens)
        FILTER (WHERE project_id IS NOT NULL AND actor_user_id IS NULL),0)::text unattributed_tokens,
      COUNT(*) FILTER (WHERE pricing_status='unpriced')::text unpriced,
      COUNT(*) FILTER (WHERE pricing_status='historical-unknown')::text historical_unknown,
      COALESCE(MAX(GREATEST(EXTRACT(epoch FROM (received_at-occurred_at))*1000,0)),0)::text max_lag_ms
      FROM harness.model_usage WHERE organization_id=$1
        AND occurred_at>=to_timestamp($2/1000.0) AND occurred_at<to_timestamp($3/1000.0)`,
    [this.context.organizationId, start, end])
    const row = result.rows[0]!
    const maxIntakeLagMs = Math.round(Number(row.max_lag_ms ?? '0'))
    if (!Number.isSafeInteger(maxIntakeLagMs) || maxIntakeLagMs < 0) throw new Error('intake lag exceeds safe integer range')
    return {
      month,
      timeZone: this.timeZone,
      missingUsageCalls: safeCount(row.missing, 'missing usage calls'),
      unattributedProjectCalls: safeCount(row.unattributed_calls, 'unattributed project calls'),
      unattributedProjectTokens: safeCount(row.unattributed_tokens, 'unattributed project tokens'),
      unpricedCalls: safeCount(row.unpriced, 'unpriced calls'),
      historicalUnknownCalls: safeCount(row.historical_unknown, 'historical unknown calls'),
      maxIntakeLagMs,
    }
  }

  private async contributorRows(
    queryable: Queryable,
    month: string,
    projectInternalId?: string,
  ): Promise<UsageContributorRow[]> {
    const { start, end } = monthBounds(month, this.timeZone)
    const values: unknown[] = [this.context.organizationId, start, end]
    const projectClause = projectInternalId === undefined ? '' : ' AND mu.project_id=$4'
    if (projectInternalId !== undefined) values.push(projectInternalId)
    const result = await queryable.query<UsageTotalsRow & {
      user_id: string
      username: string
      archived: boolean
      projects: string
    }>(`SELECT u.public_id::text user_id,u.username::text username,
      (u.deleted_at IS NOT NULL OR u.status <> 'active') archived,
      COUNT(DISTINCT mu.project_id)::text projects,
      COALESCE(SUM(mu.input_tokens),0)::text input,COALESCE(SUM(mu.output_tokens),0)::text output,
      COALESCE(SUM(mu.cache_read_tokens),0)::text read,COALESCE(SUM(mu.cache_write_tokens),0)::text write,
      COALESCE(SUM(mu.estimated_cost),0)::text cost,COALESCE(SUM(mu.company_cost),0)::text company,
      COUNT(*)::text calls,COUNT(*) FILTER (WHERE mu.status='missing-usage')::text missing,
      COUNT(*) FILTER (WHERE mu.pricing_status='priced')::text priced,
      COUNT(*) FILTER (WHERE mu.pricing_status='unpriced')::text unpriced,
      COUNT(*) FILTER (WHERE mu.pricing_status='configured-zero')::text configured_zero,
      COUNT(*) FILTER (WHERE mu.pricing_status='historical-unknown')::text unknown
      FROM harness.model_usage mu JOIN harness.users u ON u.id=mu.actor_user_id
        AND u.organization_id=mu.organization_id
      WHERE mu.organization_id=$1 AND mu.project_id IS NOT NULL AND mu.actor_user_id IS NOT NULL
        AND mu.occurred_at>=to_timestamp($2/1000.0) AND mu.occurred_at<to_timestamp($3/1000.0)${projectClause}
      GROUP BY u.public_id,u.username,u.deleted_at,u.status
      ORDER BY SUM(mu.input_tokens+mu.output_tokens+mu.cache_read_tokens+mu.cache_write_tokens) DESC,u.public_id`, values)
    return result.rows.map(row => ({
      userId: safeCount(row.user_id, 'contributor user id'),
      username: row.username,
      archived: row.archived,
      projectCount: safeCount(row.projects, 'contributor project count'),
      ...usageMeasure(row),
    }))
  }

  private async usageTotals(
    queryable: Queryable,
    subject: ModelUsageSubject,
    internalId: string,
    month: string,
  ): Promise<UsageTotalsRow> {
    const subjectColumn = subject.kind === 'user' ? 'user_id' : 'project_id'
    return this.usageTotalsWhere(queryable, `${subjectColumn}=$2`, [internalId], month)
  }

  private async usageTotalsWhere(
    queryable: Queryable,
    predicate: string,
    values: readonly unknown[],
    month: string,
  ): Promise<UsageTotalsRow> {
    const { start, end } = monthBounds(month, this.timeZone)
    const startParameter = values.length + 2
    const usage = await queryable.query<UsageTotalsRow>(`SELECT COALESCE(SUM(input_tokens),0)::text input,
      COALESCE(SUM(output_tokens),0)::text output,COALESCE(SUM(cache_read_tokens),0)::text read,
      COALESCE(SUM(cache_write_tokens),0)::text write,COALESCE(SUM(estimated_cost),0)::text cost,
      COALESCE(SUM(company_cost),0)::text company,COUNT(*)::text calls,
      COUNT(*) FILTER (WHERE status='missing-usage')::text missing,
      COUNT(*) FILTER (WHERE pricing_status='priced')::text priced,
      COUNT(*) FILTER (WHERE pricing_status='unpriced')::text unpriced,
      COUNT(*) FILTER (WHERE pricing_status='configured-zero')::text configured_zero,
      COUNT(*) FILTER (WHERE pricing_status='historical-unknown')::text unknown
      FROM harness.model_usage WHERE organization_id=$1 AND ${predicate}
        AND occurred_at>=to_timestamp($${String(startParameter)}/1000.0)
        AND occurred_at<to_timestamp($${String(startParameter + 1)}/1000.0)`,
    [this.context.organizationId, ...values, start, end])
    return usage.rows[0]!
  }

  private async summaryWith(
    queryable: Queryable,
    subject: ModelUsageSubject,
    month: string,
  ): Promise<UsageSummary> {
    return subject.kind === 'user'
      ? this.userSummaryWith(queryable, subject.id, month)
      : this.projectSummaryWith(queryable, subject.id, month)
  }

  private async userSummaryWith(queryable: Queryable, userId: number, month: string): Promise<UsageSummary> {
    const user = await queryable.query<{ id: string; role: 'admin' | 'member' | null }>(`SELECT u.id,m.role
      FROM harness.users u LEFT JOIN harness.memberships m
        ON m.organization_id=u.organization_id AND m.user_id=u.id
      WHERE u.organization_id=$1 AND u.public_id=$2`, [this.context.organizationId, userId])
    const identity = user.rows[0]
    if (identity === undefined) throw new Error(`unknown user ${String(userId)}`)
    const row = await this.usageTotals(queryable, { kind: 'user', id: userId }, identity.id, month)
    const userQuota = await queryable.query<{
      token_mode: 'inherit' | 'unlimited' | 'custom'
      token_limit: string | null
      company_cost_mode: 'inherit' | 'unlimited' | 'custom'
      company_cost_limit: string | null
    }>('SELECT token_mode,token_limit::text,company_cost_mode,company_cost_limit::text FROM harness.user_quotas WHERE user_id=$1',
    [identity.id])
    const roleQuota = identity.role === null
      ? { rows: [] as Array<{ token_limit: string | null; company_cost_limit: string | null }> }
      : await queryable.query<{ token_limit: string | null; company_cost_limit: string | null }>(`SELECT
        token_limit::text,company_cost_limit::text FROM harness.role_quotas
        WHERE organization_id=$1 AND role=$2`, [this.context.organizationId, identity.role])
    const alerts = await queryable.query<UsageAlertRow>(`SELECT metric,threshold,created_at FROM harness.model_usage_alerts
      WHERE user_id=$1 AND period_start=$2::date ORDER BY CASE metric WHEN 'tokens' THEN 0 ELSE 1 END,threshold`,
    [identity.id, `${month}-01`])
    const userLimits = userQuota.rows[0]
    const roleLimits = roleQuota.rows[0]
    const inheritedToken = roleLimits?.token_limit === null || roleLimits?.token_limit === undefined
      ? null
      : safeCount(roleLimits.token_limit, 'role token limit')
    const inheritedCost = roleLimits?.company_cost_limit === null || roleLimits?.company_cost_limit === undefined
      ? null
      : decimalToMicros(roleLimits.company_cost_limit)
    const tokenLimit = userLimits === undefined || userLimits.token_mode === 'inherit'
      ? inheritedToken
      : userLimits.token_mode === 'unlimited'
        ? null
        : safeCount(userLimits.token_limit!, 'user token limit')
    const companyCostMicrosLimit = userLimits === undefined || userLimits.company_cost_mode === 'inherit'
      ? inheritedCost
      : userLimits.company_cost_mode === 'unlimited'
        ? null
        : decimalToMicros(userLimits.company_cost_limit!)
    return usageSummary(month, row, tokenLimit, companyCostMicrosLimit, alerts.rows)
  }

  private async projectSummaryWith(queryable: Queryable, projectId: number, month: string): Promise<UsageSummary> {
    const project = await queryable.query<{ id: string }>(`SELECT id FROM harness.projects
      WHERE organization_id=$1 AND public_id=$2 AND status='active'`, [this.context.organizationId, projectId])
    const identity = project.rows[0]
    if (identity === undefined) throw new Error(`unknown project ${String(projectId)}`)
    const row = await this.usageTotals(queryable, { kind: 'project', id: projectId }, identity.id, month)
    const quota = await queryable.query<{ token_limit: string | null; company_cost_limit: string | null }>(`SELECT
      token_limit::text,company_cost_limit::text FROM harness.project_quotas WHERE project_id=$1`, [identity.id])
    const projectLimits = quota.rows[0]
    const inherited = projectLimits === undefined
      ? await queryable.query<{ token_limit: string | null; company_cost_limit: string | null }>(`SELECT
        token_limit::text,company_cost_limit::text FROM harness.role_quotas
        WHERE organization_id=$1 AND role='member'`, [this.context.organizationId])
      : undefined
    const alerts = await queryable.query<UsageAlertRow>(`SELECT metric,threshold,created_at
      FROM harness.project_usage_alerts
      WHERE project_id=$1 AND period_start=$2::date
      ORDER BY CASE metric WHEN 'tokens' THEN 0 ELSE 1 END,threshold`, [identity.id, `${month}-01`])
    const limits = projectLimits ?? inherited?.rows[0]
    return usageSummary(
      month,
      row,
      limits?.token_limit === null || limits?.token_limit === undefined
        ? null
        : safeCount(limits.token_limit, 'project token limit'),
      limits?.company_cost_limit === null || limits?.company_cost_limit === undefined
        ? null
        : decimalToMicros(limits.company_cost_limit),
      alerts.rows,
    )
  }

  private async evaluateAlerts(queryable: Queryable, subject: ModelUsageSubject, month: string): Promise<number> {
    const summary = await this.summaryWith(queryable, subject, month)
    const internalId = subject.kind === 'user'
      ? await internalUserId(queryable, this.context.organizationId, subject.id)
      : await internalProjectId(queryable, this.context.organizationId, subject.id)
    if (internalId === null) throw new Error(`unknown ${subject.kind} ${String(subject.id)}`)
    const table = subject.kind === 'user' ? 'model_usage_alerts' : 'project_usage_alerts'
    const column = subject.kind === 'user' ? 'user_id' : 'project_id'
    let inserted = 0
    for (const [metric, value, limit] of [
      ['tokens', summary.totalTokens, summary.tokenLimit],
      ['company-cost', summary.companyCostMicros, summary.companyCostMicrosLimit],
    ] as const) {
      if (limit === null || limit <= 0) continue
      for (const threshold of [80, 100] as const) {
        if (value * 100 < limit * threshold) continue
        const result = await queryable.query(`INSERT INTO harness.${table}(
          ${column},period_start,metric,threshold
        ) VALUES($1,$2::date,$3,$4) ON CONFLICT DO NOTHING`,
        [internalId, `${month}-01`, metric, threshold])
        inserted += result.rowCount ?? 0
      }
    }
    return inserted
  }

  private async bumpConfigurationRevision(queryable: Queryable): Promise<void> {
    const updated = await queryable.query(`UPDATE harness.organizations
      SET model_configuration_revision=model_configuration_revision+1,updated_at=now()
      WHERE id=$1`, [this.context.organizationId])
    if (updated.rowCount !== 1) throw new Error('organization model configuration revision update failed')
  }

  private async organizationProfiles(queryable: Queryable): Promise<Map<string, Record<string, unknown>>> {
    const providers = await queryable.query<{
      provider_key: string
      display_name: string
      protocol: ModelProviderProtocol | null
      base_url: string | null
      credential_ref: string | null
      profile: Record<string, unknown>
    }>(`SELECT provider_key,display_name,protocol,base_url,credential_ref,profile
      FROM harness.model_providers WHERE organization_id=$1 AND source='managed' AND status <> 'archived'
      ORDER BY provider_key`, [this.context.organizationId])
    const catalog = await queryable.query<{
      provider_key: string
      model_key: string
      display_name: string
    }>(`SELECT provider_key,model_key,display_name FROM harness.model_catalog
      WHERE organization_id=$1 AND enabled ORDER BY provider_key,model_key`, [this.context.organizationId])
    const modelsByProvider = new Map<string, Array<Record<string, unknown>>>()
    for (const row of catalog.rows) {
      const models = modelsByProvider.get(row.provider_key) ?? []
      models.push({ id: row.model_key, name: row.display_name })
      modelsByProvider.set(row.provider_key, models)
    }
    return new Map(providers.rows.map(row => {
      const profile = jsonObject(cloneJson(row.profile), `provider ${row.provider_key}`)
      const configuredModels = profileModelsOf(profile)
      const inheritedModels = modelsByProvider.get(row.provider_key) ?? []
      const hydrated: Record<string, unknown> = {
        ...profile,
        ...profile.displayName === undefined ? { displayName: row.display_name } : {},
        ...profile.api === undefined && row.protocol !== null ? { api: row.protocol } : {},
        ...profile.baseURL === undefined && row.base_url !== null ? { baseURL: row.base_url } : {},
        ...profile.apiKeyEnv === undefined && row.credential_ref !== null ? { apiKeyEnv: row.credential_ref } : {},
        ...configuredModels.length === 0 && inheritedModels.length > 0 ? { models: inheritedModels } : {},
      }
      return [row.provider_key, hydrated]
    }))
  }

  private async organizationSettingsView(
    profiles: Map<string, Record<string, unknown>>,
    revision: number,
    queryable: Queryable = this.context.pool,
  ): Promise<OrganizationModelSettingsView> {
    const profileObject = Object.fromEntries([...profiles.entries()].map(([provider, profile]) => [provider, cloneJson(profile)]))
    const value: unknown = { providers: profileObject }
    const refs = [...profiles.values()].flatMap(profile => {
      const ref = apiKeyRefOf(profile)
      return ref === undefined ? [] : [ref]
    })
    const configured = new Set<string>()
    if (refs.length > 0) {
      const result = await queryable.query<{ credential_ref: string }>(`SELECT provider.credential_ref
          FROM harness.model_providers provider JOIN harness.organization_model_credentials credential
            ON credential.organization_id=provider.organization_id AND credential.provider_id=provider.id
          WHERE provider.organization_id=$1 AND provider.source='managed' AND provider.status <> 'archived'
            AND provider.credential_ref = ANY($2::text[])`, [this.context.organizationId, refs])
      for (const row of result.rows) configured.add(row.credential_ref)
    }
    const secrets = [...profiles.entries()].flatMap(([provider, profile]) => {
      const ref = apiKeyRefOf(profile)
      return ref === undefined ? [] : [{ path: ['providers', provider, 'apiKeyEnv'], set: configured.has(ref) }]
    })
    return {
      writable: true,
      hasDocument: false,
      namespaces: [{
        ns: 'llm-pi-ai',
        schema: organizationModelSettingsSchema(),
        value,
        base: { providers: {} },
        user: { providers: profileObject },
        applies: 'live',
        secrets,
        revision,
      }],
    }
  }

  private async organizationCredentialExists(queryable: Queryable, providerId: string | undefined): Promise<boolean> {
    if (providerId === undefined) return false
    const result = await queryable.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM harness.organization_model_credentials
      WHERE organization_id=$1 AND provider_id=$2) exists`, [this.context.organizationId, providerId])
    return result.rows[0]?.exists === true
  }

  private async syncProviderModels(
    queryable: Queryable,
    providerId: string,
    provider: string,
    models: Array<Record<string, unknown>>,
  ): Promise<void> {
    const ids: string[] = []
    for (const [index, model] of models.entries()) {
      const id = typeof model.id === 'string' ? model.id.trim() : ''
      if (id === '') throw new Error(`provider ${provider} model ${String(index + 1)} must have an id`)
      const name = typeof model.name === 'string' && model.name.trim() !== '' ? model.name.trim() : id
      ids.push(id)
      const stored = await queryable.query<{ id: string }>(`INSERT INTO harness.model_catalog(
        organization_id,provider_id,provider_key,model_key,display_name,enabled
      ) VALUES($1,$2,$3,$4,$5,true)
      ON CONFLICT(organization_id,provider_key,model_key) DO UPDATE SET
        provider_id=excluded.provider_id,display_name=excluded.display_name,enabled=true,updated_at=now()
      RETURNING id`, [this.context.organizationId, providerId, provider, id, name])
      const modelId = stored.rows[0]?.id
      if (modelId === undefined) throw new Error(`model ${provider}/${id} upsert returned no row`)
      await queryable.query(`INSERT INTO harness.model_role_access(organization_id,role,model_id,allowed)
        VALUES($1,'admin',$2,true) ON CONFLICT DO NOTHING`, [this.context.organizationId, modelId])
      await queryable.query(`INSERT INTO harness.model_role_access(organization_id,role,model_id,allowed)
        VALUES($1,'member',$2,false) ON CONFLICT DO NOTHING`, [this.context.organizationId, modelId])
    }
    await queryable.query(`UPDATE harness.model_catalog SET enabled=false,updated_at=now()
      WHERE organization_id=$1 AND provider_id=$2 AND NOT (model_key = ANY($3::text[]))`,
    [this.context.organizationId, providerId, ids])
  }

  private async providerForCredential(queryable: Queryable, ref: string): Promise<{
    id: string
    status: 'draft' | 'enabled' | 'disabled' | 'archived'
    credential_ref: string
    profile: Record<string, unknown>
  } | undefined> {
    const result = await queryable.query<{
      id: string
      status: 'draft' | 'enabled' | 'disabled' | 'archived'
      credential_ref: string
      profile: Record<string, unknown>
    }>(`SELECT id,status,credential_ref,profile FROM harness.model_providers
      WHERE organization_id=$1 AND source='managed' AND credential_ref=$2`, [this.context.organizationId, ref])
    return result.rows[0]
  }

  private async refreshProviderReadiness(queryable: Queryable, providerId: string): Promise<void> {
    const result = await queryable.query<{
      status: 'draft' | 'enabled' | 'disabled' | 'archived'
      credential_ref: string | null
      profile: Record<string, unknown>
      models: string
      credential_configured: boolean
    }>(`SELECT provider.status,provider.credential_ref,provider.profile,COUNT(model.id)::text models,
      EXISTS(SELECT 1 FROM harness.organization_model_credentials credential
        WHERE credential.organization_id=provider.organization_id AND credential.provider_id=provider.id) credential_configured
      FROM harness.model_providers provider LEFT JOIN harness.model_catalog model
        ON model.organization_id=provider.organization_id AND model.provider_id=provider.id AND model.enabled
      WHERE provider.organization_id=$1 AND provider.id=$2 GROUP BY provider.id`, [this.context.organizationId, providerId])
    const row = result.rows[0]
    if (row === undefined || row.status === 'disabled' || row.status === 'archived') return
    const profile = jsonObject(row.profile, 'provider profile')
    const ready = typeof profile.api === 'string' && typeof profile.baseURL === 'string'
      && safeCount(row.models, 'provider model count') > 0
      && (row.credential_ref === null || row.credential_configured)
    await queryable.query(`UPDATE harness.model_providers SET status=$3,updated_at=now()
      WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, providerId, ready ? 'enabled' : 'draft'])
  }

  private async lockConfigurationRevision(queryable: Queryable): Promise<number> {
    const result = await queryable.query<{ revision: string }>(`SELECT model_configuration_revision::text revision
      FROM harness.organizations WHERE id=$1 FOR SHARE`, [this.context.organizationId])
    const revision = result.rows[0]?.revision
    if (revision === undefined) throw new Error('organization model configuration revision is unavailable')
    return safeCount(revision, 'organization model configuration revision')
  }

  private async runtimeProviders(queryable: Queryable): Promise<RuntimeModelProvider[]> {
    const result = await queryable.query<{
      provider: string
      display_name: string
      protocol: ModelProviderProtocol
      base_url: string
      credential_ref: string | null
      profile: Record<string, unknown>
      model_id: string
      model_name: string
    }>(`SELECT provider.provider_key provider,provider.display_name,provider.protocol,
      provider.base_url,provider.credential_ref,provider.profile,model.model_key model_id,model.display_name model_name
      FROM harness.model_providers provider
      JOIN harness.model_catalog model ON model.organization_id=provider.organization_id
        AND model.provider_id=provider.id
        AND model.enabled
      WHERE provider.organization_id=$1 AND provider.source='managed' AND provider.status='enabled'
      ORDER BY provider.provider_key,model.model_key`, [this.context.organizationId])
    const providers = new Map<string, RuntimeModelProvider>()
    for (const row of result.rows) {
      let provider = providers.get(row.provider)
      if (provider === undefined) {
        provider = {
          provider: row.provider,
          displayName: row.display_name,
          driver: 'pi-ai',
          protocol: row.protocol,
          baseURL: row.base_url,
          ...row.credential_ref === null ? {} : { credentialRef: row.credential_ref },
          profile: cloneJson(row.profile),
          models: [],
        }
        providers.set(row.provider, provider)
      }
      const configured = profileModelsOf(jsonObject(row.profile, `provider ${row.provider} profile`))
        .find(model => model.id === row.model_id)
      const contextWindow = typeof configured?.contextWindow === 'number' ? configured.contextWindow : undefined
      const maxTokens = typeof configured?.maxTokens === 'number' ? configured.maxTokens : undefined
      const input = Array.isArray(configured?.input)
        ? configured.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
        : undefined
      const reasoningEfforts = configured?.reasoningEfforts === false
        ? false
        : configured?.reasoningEfforts !== undefined
          && typeof configured.reasoningEfforts === 'object' && configured.reasoningEfforts !== null
          ? configured.reasoningEfforts as RuntimeModelProvider['models'][number]['reasoningEfforts']
          : undefined
      const compat = configured?.compat !== undefined && typeof configured.compat === 'object' && configured.compat !== null
        ? configured.compat as RuntimeModelProvider['models'][number]['compat']
        : undefined
      provider.models.push({
        id: row.model_id,
        name: row.model_name,
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...input === undefined ? {} : { input },
        ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
        ...compat === undefined ? {} : { compat },
      })
    }
    return [...providers.values()]
  }
}
