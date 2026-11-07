import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { load as parseYaml, YAMLException } from 'js-yaml'
import type { UserRow } from '../auth.ts'
import {
  ACCOUNT_CHAT_CONTENT_WIDTH_RANGE,
  ACCOUNT_CHAT_FONT_SIZE_RANGE,
  ACCOUNT_LINK_OPENINGS,
  ACCOUNT_PERFORMANCE_USAGE_MODES,
  ACCOUNT_PREFERENCE_DEFAULTS,
  ACCOUNT_TRANSCRIPT_VIEW_MODES,
  ACCOUNT_THEME_FONT_SIZES,
  ACCOUNT_THEME_FONT_FAMILIES,
  AccountPreferencesConflictError,
  AccountPreferencesUnavailableError,
  DEFAULT_ACCOUNT_CHAT_CONTENT_WIDTH,
  DEFAULT_ACCOUNT_CHAT_FONT_SIZE,
  type AccountLinkOpening,
  type AccountPerformanceUsageMode,
  type AccountPreferenceMutation,
  type AccountPreferenceValues,
  type AccountPreferencesView,
  type AccountTranscriptViewMode,
  type AccountThemePreferences,
  type GatewayAccountPreferencesService,
  normalizeAccountPreferenceMutation,
} from '../account-preferences.ts'
import type { GatewayConfig } from '../config.ts'
import { transaction } from './database.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'
import { lockActiveAccount, type ActiveAccount } from './account-authority.ts'

interface PreferenceRow {
  locale_preference: 'zh' | 'en' | null
  theme_preference: 'light' | 'dark' | 'system' | null
  busy_enter: 'queue' | 'steer' | null
  chat_content_width: number | string | null
  chat_full_width: boolean | null
  chat_font_size: number | string | null
  transcript_view: string | null
  performance_usage: string | null
  link_opening: string | null
  revision: string
  migrated_at: Date | null
  font_size: number | null
  code_font_size: number | null
  terminal_font_size: number | null
  text_font_family: string | null
  code_font_family: string | null
  terminal_font_family: string | null
  theme_fonts_migrated_at: Date | null
}

interface LegacyPreferences {
  fonts?: Partial<Omit<AccountThemePreferences, 'preference'>>
  locale?: 'zh' | 'en'
  theme?: 'light' | 'dark' | 'system'
  busyEnter?: 'queue' | 'steer'
  chatContentWidth?: number
  chatFullWidth?: boolean
  chatFontSize?: number
  transcriptView?: AccountTranscriptViewMode
  performanceUsage?: AccountPerformanceUsageMode
  linkOpening?: AccountLinkOpening
}

function safeRevision(value: string | number): number {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`account preference revision is not a non-negative safe integer: ${String(value)}`)
  }
  return revision
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function legacyPreferences(value: unknown): LegacyPreferences {
  const root = object(value)
  if (root === undefined) return {}
  const locale = object(root.locale)?.preference
  const themeSection = object(root['ui-theme'])
  const theme = themeSection?.preference
  const fonts: Partial<Omit<AccountThemePreferences, 'preference'>> = {}
  for (const field of Object.keys(ACCOUNT_THEME_FONT_SIZES) as (keyof typeof ACCOUNT_THEME_FONT_SIZES)[]) {
    const raw = themeSection?.[field], spec = ACCOUNT_THEME_FONT_SIZES[field]
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= spec.min && raw <= spec.max) fonts[field] = raw
  }
  for (const field of ACCOUNT_THEME_FONT_FAMILIES) {
    const raw = themeSection?.[field]
    if (typeof raw === 'string') fonts[field] = raw
  }
  const conversation = object(root['ui-conversation'])
  const busyEnter = conversation?.busyEnter
  const rawWidth = conversation?.chatContentWidth
  const rawFontSize = conversation?.chatFontSize
  const chatContentWidth = typeof rawWidth === 'number' && Number.isSafeInteger(rawWidth)
    && rawWidth >= ACCOUNT_CHAT_CONTENT_WIDTH_RANGE.min
    && rawWidth <= ACCOUNT_CHAT_CONTENT_WIDTH_RANGE.max
    ? rawWidth
    : undefined
  const chatFontSize = typeof rawFontSize === 'number' && Number.isSafeInteger(rawFontSize)
    && rawFontSize >= ACCOUNT_CHAT_FONT_SIZE_RANGE.min
    && rawFontSize <= ACCOUNT_CHAT_FONT_SIZE_RANGE.max
    ? rawFontSize
    : undefined
  const rawTranscriptView = conversation?.transcriptView
  // Legacy saved modes read as `detailed` at the schema layer; the account
  // column stores only current modes, so the migration folds them forward.
  const transcriptView = ACCOUNT_TRANSCRIPT_VIEW_MODES.includes(rawTranscriptView as AccountTranscriptViewMode)
    ? rawTranscriptView as AccountTranscriptViewMode
    : rawTranscriptView === 'normal' || rawTranscriptView === 'expanded'
      ? 'detailed' as const
      : undefined
  const rawPerformanceUsage = conversation?.performanceUsage
  const rawLinkOpening = conversation?.linkOpening
  return {
    ...(Object.keys(fonts).length === 0 ? {} : { fonts }),
    ...(locale === 'zh' || locale === 'en' ? { locale } : {}),
    ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
    ...(busyEnter === 'queue' || busyEnter === 'steer' ? { busyEnter } : {}),
    ...(chatContentWidth === undefined ? {} : { chatContentWidth }),
    ...(typeof conversation?.chatFullWidth === 'boolean' ? { chatFullWidth: conversation.chatFullWidth } : {}),
    ...(chatFontSize === undefined ? {} : { chatFontSize }),
    ...(transcriptView === undefined ? {} : { transcriptView }),
    ...(ACCOUNT_PERFORMANCE_USAGE_MODES.includes(rawPerformanceUsage as AccountPerformanceUsageMode)
      ? { performanceUsage: rawPerformanceUsage as AccountPerformanceUsageMode } : {}),
    ...(ACCOUNT_LINK_OPENINGS.includes(rawLinkOpening as AccountLinkOpening)
      ? { linkOpening: rawLinkOpening as AccountLinkOpening } : {}),
  }
}

/** Read only the legacy preference fields from a user's private settings file. */
async function readLegacyPreferences(config: GatewayConfig, username: string): Promise<LegacyPreferences> {
  const path = join(config.usersRoot, username, 'dsh', 'settings.yaml')
  let raw: string
  try {
    await using file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!(await file.stat()).isFile()) throw new Error('Legacy account settings is not a regular file')
    raw = await file.readFile('utf8')
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code === 'ENOENT') return {}
    throw new AccountPreferencesUnavailableError(error)
  }
  try {
    return legacyPreferences(parseYaml(raw))
  } catch (error) {
    if (error instanceof YAMLException) return {}
    throw error
  }
}

function storedNumber(
  value: number | string | null,
  fallback: number,
  range: { min: number; max: number },
  field: string,
): number {
  if (value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new Error(`account preference ${field} is outside its supported range`)
  }
  return parsed
}

function storedEnum<T extends string>(value: string | null, allowed: readonly T[], field: string): T | null {
  if (value === null) return null
  if (!allowed.includes(value as T)) {
    throw new Error(`account preference ${field} holds an unsupported value`)
  }
  return value as T
}

function viewOf(row: PreferenceRow): AccountPreferencesView {
  const fonts = {
    fontSize: storedNumber(row.font_size, 14, ACCOUNT_THEME_FONT_SIZES.fontSize, 'fontSize'),
    codeFontSize: storedNumber(row.code_font_size, 11, ACCOUNT_THEME_FONT_SIZES.codeFontSize, 'codeFontSize'),
    terminalFontSize: storedNumber(row.terminal_font_size, 13, ACCOUNT_THEME_FONT_SIZES.terminalFontSize, 'terminalFontSize'),
    textFontFamily: row.text_font_family ?? '',
    codeFontFamily: row.code_font_family ?? '',
    terminalFontFamily: row.terminal_font_family ?? '',
  }
  const chatContentWidth = storedNumber(
    row.chat_content_width,
    DEFAULT_ACCOUNT_CHAT_CONTENT_WIDTH,
    ACCOUNT_CHAT_CONTENT_WIDTH_RANGE,
    'chatContentWidth',
  )
  const chatFontSize = storedNumber(
    row.chat_font_size,
    DEFAULT_ACCOUNT_CHAT_FONT_SIZE,
    ACCOUNT_CHAT_FONT_SIZE_RANGE,
    'chatFontSize',
  )
  const transcriptView = storedEnum(row.transcript_view, ACCOUNT_TRANSCRIPT_VIEW_MODES, 'transcriptView')
  const performanceUsage = storedEnum(row.performance_usage, ACCOUNT_PERFORMANCE_USAGE_MODES, 'performanceUsage')
  const linkOpening = storedEnum(row.link_opening, ACCOUNT_LINK_OPENINGS, 'linkOpening')
  const values: AccountPreferenceValues = {
    locale: row.locale_preference === null ? {} : { preference: row.locale_preference },
    'ui-theme': { ...fonts, preference: row.theme_preference ?? ACCOUNT_PREFERENCE_DEFAULTS['ui-theme'].preference },
    'ui-conversation': {
      busyEnter: row.busy_enter ?? ACCOUNT_PREFERENCE_DEFAULTS['ui-conversation'].busyEnter,
      chatContentWidth,
      chatFullWidth: row.chat_full_width ?? ACCOUNT_PREFERENCE_DEFAULTS['ui-conversation'].chatFullWidth,
      chatFontSize,
      transcriptView: transcriptView ?? ACCOUNT_PREFERENCE_DEFAULTS['ui-conversation'].transcriptView,
      performanceUsage: performanceUsage ?? ACCOUNT_PREFERENCE_DEFAULTS['ui-conversation'].performanceUsage,
      linkOpening: linkOpening ?? ACCOUNT_PREFERENCE_DEFAULTS['ui-conversation'].linkOpening,
    },
  }
  const overrides = {
    locale: row.locale_preference === null ? {} : { preference: row.locale_preference },
    'ui-theme': {
      ...(row.theme_preference === null ? {} : { preference: row.theme_preference }),
      ...Object.fromEntries(FONT_FIELDS.filter(field => row[FONT_COLUMNS[field]] !== null).map(field => [field, fonts[field]])),
    },
    'ui-conversation': {
      ...(row.busy_enter === null ? {} : { busyEnter: row.busy_enter }),
      ...(row.chat_content_width === null ? {} : { chatContentWidth }),
      ...(row.chat_full_width === null ? {} : { chatFullWidth: row.chat_full_width }),
      ...(row.chat_font_size === null ? {} : { chatFontSize }),
      ...(transcriptView === null ? {} : { transcriptView }),
      ...(performanceUsage === null ? {} : { performanceUsage }),
      ...(linkOpening === null ? {} : { linkOpening }),
    },
  }
  return {
    revision: safeRevision(row.revision),
    values,
    overrides,
    migrated: row.migrated_at !== null,
  }
}

/** Every preference column projected into `PreferenceRow`; shared by the SELECT and RETURNING lists. */
const PREFERENCE_COLUMNS = 'locale_preference,theme_preference,busy_enter,'
  + 'chat_content_width,chat_full_width,chat_font_size,'
  + 'transcript_view,performance_usage,link_opening,'
  + 'font_size,code_font_size,terminal_font_size,text_font_family,code_font_family,terminal_font_family,theme_fonts_migrated_at'

const FONT_COLUMNS = {
  fontSize: 'font_size', codeFontSize: 'code_font_size', terminalFontSize: 'terminal_font_size',
  textFontFamily: 'text_font_family', codeFontFamily: 'code_font_family', terminalFontFamily: 'terminal_font_family',
} as const
const FONT_FIELDS = Object.keys(FONT_COLUMNS) as (keyof typeof FONT_COLUMNS)[]
const THEME_COLUMNS: Record<string, string> = { preference: 'theme_preference', ...FONT_COLUMNS }

/** `ui-conversation` wire field to its `harness.user_preferences` column. */
const CONVERSATION_COLUMNS: Record<string, string> = {
  busyEnter: 'busy_enter',
  chatContentWidth: 'chat_content_width',
  chatFullWidth: 'chat_full_width',
  chatFontSize: 'chat_font_size',
  transcriptView: 'transcript_view',
  performanceUsage: 'performance_usage',
  linkOpening: 'link_opening',
}

/** PostgreSQL account preference store shared by every Gateway process. */
export class PostgresAccountPreferencesService implements GatewayAccountPreferencesService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly config: GatewayConfig,
  ) {}

  async describe(user: UserRow): Promise<AccountPreferencesView> {
    return transaction(this.context.pool, async (client) => {
      const account = await lockActiveAccount(client, this.context, user.id)
      return viewOf(await this.ensureRow(client, account))
    })
  }

  async mutate(user: UserRow, input: AccountPreferenceMutation): Promise<AccountPreferencesView> {
    const mutation = normalizeAccountPreferenceMutation(input)
    return transaction(this.context.pool, async (client) => {
      const account = await lockActiveAccount(client, this.context, user.id)
      const row = await this.ensureRow(client, account)
      const revision = safeRevision(row.revision)
      if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== revision) {
        throw new AccountPreferencesConflictError(mutation.expectedRevision, revision)
      }
      const column = mutation.namespace === 'locale'
        ? 'locale_preference'
        : mutation.namespace === 'ui-theme'
          ? THEME_COLUMNS[mutation.field]
          : CONVERSATION_COLUMNS[mutation.field]
      const value = mutation.operation === 'unset' ? null : mutation.value
      const result = await client.query<PreferenceRow>(`UPDATE harness.user_preferences
        SET ${column}=$3,revision=revision+1,updated_at=now()
        WHERE organization_id=$1 AND user_id=$2
        RETURNING ${PREFERENCE_COLUMNS},revision::text,migrated_at`, [
        this.context.organizationId,
        account.id,
        value,
      ])
      const next = result.rows[0]
      if (next === undefined) throw new Error('account preference update returned no row')
      return viewOf(next)
    })
  }

  private async ensureRow(client: import('pg').PoolClient, account: ActiveAccount): Promise<PreferenceRow> {
    const internal = account.id
    const existing = await client.query<PreferenceRow>(`SELECT ${PREFERENCE_COLUMNS},revision::text,migrated_at
      FROM harness.user_preferences
      WHERE organization_id=$1 AND user_id=$2
      FOR UPDATE`, [this.context.organizationId, internal])
    const current = existing.rows[0]
    if (current !== undefined) return this.migrateFonts(client, account, current)

    const legacy = await readLegacyPreferences(this.config, account.username)
    const revision = legacy.locale !== undefined || legacy.theme !== undefined || legacy.busyEnter !== undefined
      || legacy.chatContentWidth !== undefined || legacy.chatFullWidth !== undefined
      || legacy.chatFontSize !== undefined || legacy.transcriptView !== undefined
      || legacy.performanceUsage !== undefined || legacy.linkOpening !== undefined || legacy.fonts !== undefined ? 1 : 0
    const migratedAt = revision === 0 ? null : new Date()
    await client.query(`INSERT INTO harness.user_preferences(
      organization_id,user_id,locale_preference,theme_preference,busy_enter,
      chat_content_width,chat_full_width,chat_font_size,
      transcript_view,performance_usage,link_opening,revision,migrated_at,
      font_size,code_font_size,terminal_font_size,text_font_family,code_font_family,terminal_font_family,theme_fonts_migrated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
    ON CONFLICT (organization_id,user_id) DO NOTHING`, [
      this.context.organizationId,
      internal,
      legacy.locale ?? null,
      legacy.theme ?? null,
      legacy.busyEnter ?? null,
      legacy.chatContentWidth ?? null,
      legacy.chatFullWidth ?? null,
      legacy.chatFontSize ?? null,
      legacy.transcriptView ?? null,
      legacy.performanceUsage ?? null,
      legacy.linkOpening ?? null,
      revision,
      migratedAt,
      ...FONT_FIELDS.map(field => legacy.fonts?.[field] ?? null),
    ])
    const inserted = await client.query<PreferenceRow>(`SELECT ${PREFERENCE_COLUMNS},revision::text,migrated_at
      FROM harness.user_preferences
      WHERE organization_id=$1 AND user_id=$2
      FOR UPDATE`, [this.context.organizationId, internal])
    const row = inserted.rows[0]
    if (row === undefined) throw new Error('account preference initialization returned no row')
    return row
  }

  /** Import absent font fields once, preserving explicit account values and resets. */
  private async migrateFonts(client: import('pg').PoolClient, account: ActiveAccount, row: PreferenceRow): Promise<PreferenceRow> {
    if (row.theme_fonts_migrated_at !== null) return row
    const missing = FONT_FIELDS.filter(field => row[FONT_COLUMNS[field]] === null)
    const fonts = missing.length === 0 ? undefined : (await readLegacyPreferences(this.config, account.username)).fonts
    const changed = missing.some(field => fonts?.[field] !== undefined)
    const assignments = FONT_FIELDS.map((field, index) => `${FONT_COLUMNS[field]}=COALESCE(${FONT_COLUMNS[field]},$${String(index + 3)})`)
    const result = await client.query<PreferenceRow>(`UPDATE harness.user_preferences SET
      ${assignments.join(',')},theme_fonts_migrated_at=now(),revision=revision+$9,
      migrated_at=CASE WHEN $9=1 THEN COALESCE(migrated_at,now()) ELSE migrated_at END,updated_at=now()
      WHERE organization_id=$1 AND user_id=$2 RETURNING ${PREFERENCE_COLUMNS},revision::text,migrated_at`, [
      this.context.organizationId, account.id, ...FONT_FIELDS.map(field => fonts?.[field] ?? null), changed ? 1 : 0,
    ])
    const migrated = result.rows[0]
    if (migrated === undefined) throw new Error('account font preference migration returned no row')
    return migrated
  }
}
