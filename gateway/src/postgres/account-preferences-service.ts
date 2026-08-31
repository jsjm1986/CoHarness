import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import type { UserRow } from '../auth.ts'
import {
  ACCOUNT_CHAT_CONTENT_WIDTH_RANGE,
  ACCOUNT_CHAT_FONT_SIZE_RANGE,
  ACCOUNT_PREFERENCE_DEFAULTS,
  AccountPreferencesConflictError,
  AccountPreferencesInputError,
  DEFAULT_ACCOUNT_CHAT_CONTENT_WIDTH,
  DEFAULT_ACCOUNT_CHAT_FONT_SIZE,
  type AccountPreferenceMutation,
  type AccountPreferenceValues,
  type AccountPreferencesView,
  type GatewayAccountPreferencesService,
  normalizeAccountPreferenceMutation,
} from '../account-preferences.ts'
import type { GatewayConfig } from '../config.ts'
import { transaction } from './database.ts'
import { internalUserId, type PostgresRuntimeContext } from './runtime-context.ts'

interface PreferenceRow {
  locale_preference: 'zh' | 'en' | null
  theme_preference: 'light' | 'dark' | 'system' | null
  busy_enter: 'queue' | 'steer' | null
  chat_content_width: number | string | null
  chat_font_size: number | string | null
  revision: string
  migrated_at: Date | null
}

interface LegacyPreferences {
  locale?: 'zh' | 'en'
  theme?: 'light' | 'dark' | 'system'
  busyEnter?: 'queue' | 'steer'
  chatContentWidth?: number
  chatFontSize?: number
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
  const theme = object(root['ui-theme'])?.preference
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
  return {
    ...(locale === 'zh' || locale === 'en' ? { locale } : {}),
    ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
    ...(busyEnter === 'queue' || busyEnter === 'steer' ? { busyEnter } : {}),
    ...(chatContentWidth === undefined ? {} : { chatContentWidth }),
    ...(chatFontSize === undefined ? {} : { chatFontSize }),
  }
}

/** Read only the legacy preference fields from a user's private settings file. */
async function readLegacyPreferences(config: GatewayConfig, user: UserRow): Promise<LegacyPreferences> {
  const path = join(config.usersRoot, user.username, 'dsh', 'settings.yaml')
  try {
    return legacyPreferences(parseYaml(await readFile(path, 'utf8')))
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    // An absent or malformed legacy file should never prevent account login or
    // preference reads; the account row is initialized with product defaults.
    if (code === 'ENOENT' || error instanceof Error) return {}
    return {}
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

function viewOf(row: PreferenceRow): AccountPreferencesView {
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
  const values: AccountPreferenceValues = {
    locale: row.locale_preference === null ? {} : { preference: row.locale_preference },
    'ui-theme': { preference: row.theme_preference ?? ACCOUNT_PREFERENCE_DEFAULTS['ui-theme'].preference },
    'ui-conversation': {
      busyEnter: row.busy_enter ?? ACCOUNT_PREFERENCE_DEFAULTS['ui-conversation'].busyEnter,
      chatContentWidth,
      chatFontSize,
    },
  }
  const overrides = {
    locale: row.locale_preference === null ? {} : { preference: row.locale_preference },
    'ui-theme': row.theme_preference === null ? {} : { preference: row.theme_preference },
    'ui-conversation': {
      ...(row.busy_enter === null ? {} : { busyEnter: row.busy_enter }),
      ...(row.chat_content_width === null ? {} : { chatContentWidth }),
      ...(row.chat_font_size === null ? {} : { chatFontSize }),
    },
  }
  return {
    revision: safeRevision(row.revision),
    values,
    overrides,
    migrated: row.migrated_at !== null,
  }
}

/** PostgreSQL account preference store shared by every Gateway process. */
export class PostgresAccountPreferencesService implements GatewayAccountPreferencesService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly config: GatewayConfig,
  ) {}

  async describe(user: UserRow): Promise<AccountPreferencesView> {
    return transaction(this.context.pool, async (client) => viewOf(await this.ensureRow(client, user)))
  }

  async mutate(user: UserRow, input: AccountPreferenceMutation): Promise<AccountPreferencesView> {
    const mutation = normalizeAccountPreferenceMutation(input)
    return transaction(this.context.pool, async (client) => {
      const row = await this.ensureRow(client, user)
      const revision = safeRevision(row.revision)
      if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== revision) {
        throw new AccountPreferencesConflictError(mutation.expectedRevision, revision)
      }
      const column = mutation.namespace === 'locale'
        ? 'locale_preference'
        : mutation.namespace === 'ui-theme'
          ? 'theme_preference'
          : mutation.field === 'busyEnter'
            ? 'busy_enter'
            : mutation.field === 'chatContentWidth'
              ? 'chat_content_width'
              : 'chat_font_size'
      const value = mutation.operation === 'unset' ? null : mutation.value
      const result = await client.query<PreferenceRow>(`UPDATE harness.user_preferences
        SET ${column}=$3,revision=revision+1,updated_at=now()
        WHERE organization_id=$1 AND user_id=$2
        RETURNING locale_preference,theme_preference,busy_enter,chat_content_width,chat_font_size,revision::text,migrated_at`, [
        this.context.organizationId,
        await internalUserId(client, this.context.organizationId, user.id),
        value,
      ])
      const next = result.rows[0]
      if (next === undefined) throw new Error('account preference update returned no row')
      return viewOf(next)
    })
  }

  private async ensureRow(client: import('pg').PoolClient, user: UserRow): Promise<PreferenceRow> {
    const internal = await internalUserId(client, this.context.organizationId, user.id)
    if (internal === null) throw new AccountPreferencesInputError(`unknown user ${String(user.id)}`)
    const existing = await client.query<PreferenceRow>(`SELECT locale_preference,theme_preference,busy_enter,
      chat_content_width,chat_font_size,
      revision::text,migrated_at
      FROM harness.user_preferences
      WHERE organization_id=$1 AND user_id=$2
      FOR UPDATE`, [this.context.organizationId, internal])
    const current = existing.rows[0]
    if (current !== undefined) return current

    const legacy = await readLegacyPreferences(this.config, user)
    const revision = legacy.locale !== undefined || legacy.theme !== undefined || legacy.busyEnter !== undefined
      || legacy.chatContentWidth !== undefined || legacy.chatFontSize !== undefined ? 1 : 0
    const migratedAt = revision === 0 ? null : new Date()
    await client.query(`INSERT INTO harness.user_preferences(
      organization_id,user_id,locale_preference,theme_preference,busy_enter,
      chat_content_width,chat_font_size,revision,migrated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (organization_id,user_id) DO NOTHING`, [
      this.context.organizationId,
      internal,
      legacy.locale ?? null,
      legacy.theme ?? null,
      legacy.busyEnter ?? null,
      legacy.chatContentWidth ?? null,
      legacy.chatFontSize ?? null,
      revision,
      migratedAt,
    ])
    const inserted = await client.query<PreferenceRow>(`SELECT locale_preference,theme_preference,busy_enter,
      chat_content_width,chat_font_size,
      revision::text,migrated_at
      FROM harness.user_preferences
      WHERE organization_id=$1 AND user_id=$2
      FOR UPDATE`, [this.context.organizationId, internal])
    const row = inserted.rows[0]
    if (row === undefined) throw new Error('account preference initialization returned no row')
    return row
  }
}
