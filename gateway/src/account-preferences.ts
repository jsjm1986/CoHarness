import type { UserRow } from './auth.ts'

/** Namespaces whose values follow an authenticated account across runtimes. */
export type AccountPreferenceNamespace = 'locale' | 'ui-theme' | 'ui-conversation'

/** Fields accepted for each account preference namespace. */
export type AccountPreferenceField =
  | { namespace: 'locale'; field: 'preference' }
  | { namespace: 'ui-theme'; field: keyof AccountThemePreferences }
  | {
    namespace: 'ui-conversation'
    field:
      | 'busyEnter' | 'chatContentWidth' | 'chatFullWidth' | 'chatFontSize'
      | 'transcriptView' | 'performanceUsage' | 'linkOpening'
  }

/** Work-details presentation modes an account may persist. */
export const ACCOUNT_TRANSCRIPT_VIEW_MODES = ['compact', 'standard', 'detailed', 'verbose'] as const

/** Detail levels an account may persist for composer statistics and usage. */
export const ACCOUNT_PERFORMANCE_USAGE_MODES = ['compact', 'detailed'] as const

/** Link destinations an account may persist for Chat HTTP(S) links. */
export const ACCOUNT_LINK_OPENINGS = ['sidebar', 'new-tab'] as const

/** Persisted work-details presentation mode. */
export type AccountTranscriptViewMode = typeof ACCOUNT_TRANSCRIPT_VIEW_MODES[number]

/** Persisted performance and usage detail level. */
export type AccountPerformanceUsageMode = typeof ACCOUNT_PERFORMANCE_USAGE_MODES[number]

/** Persisted Chat link destination. */
export type AccountLinkOpening = typeof ACCOUNT_LINK_OPENINGS[number]

/** Account-owned transcript width limits shared by the browser controls. */
export const ACCOUNT_CHAT_CONTENT_WIDTH_RANGE = { min: 560, max: 1080 } as const

/** Account-owned transcript font-size limits shared by the browser controls. */
export const ACCOUNT_CHAT_FONT_SIZE_RANGE = { min: 12, max: 17 } as const

/** Default transcript width when an account has no explicit override. */
export const DEFAULT_ACCOUNT_CHAT_CONTENT_WIDTH = 748

/** Default transcript font size when an account has no explicit override. */
export const DEFAULT_ACCOUNT_CHAT_FONT_SIZE = 14

/** Default work-details presentation when an account has no explicit override. */
export const DEFAULT_ACCOUNT_TRANSCRIPT_VIEW: AccountTranscriptViewMode = 'detailed'

/** Default usage detail when an account has no explicit override. */
export const DEFAULT_ACCOUNT_PERFORMANCE_USAGE: AccountPerformanceUsageMode = 'detailed'

/** Default Chat link destination when an account has no explicit override. */
export const DEFAULT_ACCOUNT_LINK_OPENING: AccountLinkOpening = 'sidebar'

/** Account font-size limits and defaults, matching the theme controls. */
export const ACCOUNT_THEME_FONT_SIZES = {
  fontSize: { min: 10, max: 22, default: 14 },
  codeFontSize: { min: 10, max: 16, default: 11 },
  terminalFontSize: { min: 10, max: 20, default: 13 },
} as const

/** Account-owned font-family lists; empty strings explicitly select built-in fonts. */
export const ACCOUNT_THEME_FONT_FAMILIES = ['textFontFamily', 'codeFontFamily', 'terminalFontFamily'] as const

/** Effective appearance and font values owned by one authenticated account. */
export interface AccountThemePreferences {
  preference: 'light' | 'dark' | 'system'
  fontSize: number
  codeFontSize: number
  terminalFontSize: number
  textFontFamily: string
  codeFontFamily: string
  terminalFontFamily: string
}

/** Effective account preferences returned to browser clients. */
export interface AccountPreferenceValues {
  locale: { preference?: 'zh' | 'en' }
  'ui-theme': AccountThemePreferences
  'ui-conversation': {
    busyEnter: 'queue' | 'steer'
    chatContentWidth: number
    chatFullWidth: boolean
    chatFontSize: number
    transcriptView: AccountTranscriptViewMode
    performanceUsage: AccountPerformanceUsageMode
    linkOpening: AccountLinkOpening
  }
}

/** Redacted account preference response. Values never contain credentials. */
export interface AccountPreferencesView {
  /** One account-wide revision fencing every mutation. */
  revision: number
  /** Effective values after account defaults. */
  values: AccountPreferenceValues
  /** Explicit account layer; omitted fields inherit product defaults. */
  overrides: {
    locale: { preference?: 'zh' | 'en' }
    'ui-theme': Partial<AccountThemePreferences>
    'ui-conversation': {
      busyEnter?: 'queue' | 'steer'
      chatContentWidth?: number
      chatFullWidth?: boolean
      chatFontSize?: number
      transcriptView?: AccountTranscriptViewMode
      performanceUsage?: AccountPerformanceUsageMode
      linkOpening?: AccountLinkOpening
    }
  }
  /** Whether the account row has been migrated from the legacy settings file. */
  migrated: boolean
}

/** One narrow account preference mutation. */
export type AccountPreferenceMutation = AccountPreferenceField & {
  operation: 'set' | 'unset'
  value?: string | number | boolean
  expectedRevision?: number
}

/** Account preference persistence consumed by the Gateway HTTP server. */
export interface GatewayAccountPreferencesService {
  /**
   * Read this account's preferences while retaining current account and organization eligibility.
   * @param user - authenticated account; cached status and role do not confer authority.
   * @returns effective values; first read migrates valid legacy fields or initializes defaults for absent/malformed YAML.
   */
  describe(user: UserRow): Promise<AccountPreferencesView>
  /**
   * Update an account-owned field in the same transaction as its current authority check.
   * @param user - authenticated account; no computer execution grant is required.
   * @param mutation - validated field operation and optional revision fence.
   * @returns accepted values; rejection and legacy read failures publish no initialization or mutation.
   */
  mutate(user: UserRow, mutation: AccountPreferenceMutation): Promise<AccountPreferencesView>
}

/** Legacy account storage could not be read; initialization remains uncommitted and can retry. */
export class AccountPreferencesUnavailableError extends Error {
  readonly code = 'account-preferences-unavailable'

  constructor(cause: unknown) {
    super('Account preferences could not be loaded. Try again later.', { cause })
    this.name = 'AccountPreferencesUnavailableError'
  }
}

/** A stale account preference write. */
export class AccountPreferencesConflictError extends Error {
  readonly code = 'account-preferences-conflict'

  constructor(readonly expected: number, readonly actual: number) {
    super(`account preference revision ${String(expected)} is stale; current revision is ${String(actual)}`)
    this.name = 'AccountPreferencesConflictError'
  }
}

/** A malformed account preference mutation. */
export class AccountPreferencesInputError extends Error {
  readonly code = 'invalid-account-preference'

  constructor(message: string) {
    super(message)
    this.name = 'AccountPreferencesInputError'
  }
}

/** Default values used when an account has not selected an explicit value. */
export const ACCOUNT_PREFERENCE_DEFAULTS: AccountPreferenceValues = {
  locale: {},
  'ui-theme': {
    preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
  },
  'ui-conversation': {
    busyEnter: 'queue',
    chatContentWidth: DEFAULT_ACCOUNT_CHAT_CONTENT_WIDTH,
    chatFullWidth: false,
    chatFontSize: DEFAULT_ACCOUNT_CHAT_FONT_SIZE,
    transcriptView: DEFAULT_ACCOUNT_TRANSCRIPT_VIEW,
    performanceUsage: DEFAULT_ACCOUNT_PERFORMANCE_USAGE,
    linkOpening: DEFAULT_ACCOUNT_LINK_OPENING,
  },
}

/** Validate a positive, finite revision received from a browser. */
export function assertPreferenceRevision(value: unknown): asserts value is number | undefined {
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
    throw new AccountPreferencesInputError('expectedRevision must be a non-negative safe integer')
  }
}

/** Validate one account mutation and return its normalized value. */
export function normalizeAccountPreferenceMutation(
  value: unknown,
): AccountPreferenceMutation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountPreferencesInputError('account preference mutation must be an object')
  }
  const row = value as Record<string, unknown>
  const namespace = row.namespace
  const field = row.field
  const operation = row.operation
  if (namespace !== 'locale' && namespace !== 'ui-theme' && namespace !== 'ui-conversation') {
    throw new AccountPreferencesInputError('unsupported account preference namespace')
  }
  const validField = namespace === 'ui-conversation'
    ? field === 'busyEnter' || field === 'chatContentWidth' || field === 'chatFullWidth' || field === 'chatFontSize'
      || field === 'transcriptView' || field === 'performanceUsage' || field === 'linkOpening'
    : field === 'preference' || namespace === 'ui-theme'
      && (field === 'fontSize' || field === 'codeFontSize' || field === 'terminalFontSize'
        || field === 'textFontFamily' || field === 'codeFontFamily' || field === 'terminalFontFamily')
  if (!validField) throw new AccountPreferencesInputError('unsupported account preference field')
  if (operation !== 'set' && operation !== 'unset') {
    throw new AccountPreferencesInputError('account preference operation must be set or unset')
  }
  assertPreferenceRevision(row.expectedRevision)
  const raw = row.value
  const numericConversationField = namespace === 'ui-conversation'
    && (field === 'chatContentWidth' || field === 'chatFontSize')
  const themeFontRange = namespace === 'ui-theme'
    && (field === 'fontSize' || field === 'codeFontSize' || field === 'terminalFontSize')
    ? ACCOUNT_THEME_FONT_SIZES[field] : undefined
  const numericPreferenceField = numericConversationField || themeFontRange !== undefined
  const booleanConversationField = namespace === 'ui-conversation' && field === 'chatFullWidth'
  if (operation === 'set' && numericPreferenceField
    && typeof raw !== 'number' && typeof raw !== 'string') {
    throw new AccountPreferencesInputError('numeric display preference requires a number')
  }
  if (operation === 'set' && booleanConversationField && typeof raw !== 'boolean') {
    throw new AccountPreferencesInputError('chatFullWidth preference must be a boolean')
  }
  if (operation === 'set' && !numericPreferenceField && !booleanConversationField && typeof raw !== 'string') {
    throw new AccountPreferencesInputError('account preference set requires a string value')
  }
  if (namespace === 'locale' && field === 'preference' && operation === 'set'
    && raw !== 'zh' && raw !== 'en') {
    throw new AccountPreferencesInputError('locale preference must be zh or en')
  }
  if (namespace === 'ui-theme' && field === 'preference' && operation === 'set'
    && raw !== 'light' && raw !== 'dark' && raw !== 'system') {
    throw new AccountPreferencesInputError('theme preference must be light, dark, or system')
  }
  if (namespace === 'ui-conversation' && field === 'busyEnter' && operation === 'set'
    && raw !== 'queue' && raw !== 'steer') {
    throw new AccountPreferencesInputError('busyEnter preference must be queue or steer')
  }
  if (namespace === 'ui-conversation' && field === 'transcriptView' && operation === 'set'
    && !ACCOUNT_TRANSCRIPT_VIEW_MODES.includes(raw as AccountTranscriptViewMode)) {
    throw new AccountPreferencesInputError('transcriptView preference must be a supported work-details mode')
  }
  if (namespace === 'ui-conversation' && field === 'performanceUsage' && operation === 'set'
    && !ACCOUNT_PERFORMANCE_USAGE_MODES.includes(raw as AccountPerformanceUsageMode)) {
    throw new AccountPreferencesInputError('performanceUsage preference must be compact or detailed')
  }
  if (namespace === 'ui-conversation' && field === 'linkOpening' && operation === 'set'
    && !ACCOUNT_LINK_OPENINGS.includes(raw as AccountLinkOpening)) {
    throw new AccountPreferencesInputError('linkOpening preference must be sidebar or new-tab')
  }
  if (numericPreferenceField && operation === 'set') {
    const numberValue = typeof raw === 'number' ? raw : Number(raw)
    const range = themeFontRange ?? (field === 'chatContentWidth'
      ? ACCOUNT_CHAT_CONTENT_WIDTH_RANGE
      : ACCOUNT_CHAT_FONT_SIZE_RANGE)
    if (!Number.isSafeInteger(numberValue) || numberValue < range.min || numberValue > range.max) {
      throw new AccountPreferencesInputError(
        `${field} must be an integer between ${String(range.min)} and ${String(range.max)}`,
      )
    }
    return {
      namespace,
      field: field as AccountPreferenceField['field'],
      operation,
      value: numberValue,
      ...(row.expectedRevision === undefined ? {} : { expectedRevision: row.expectedRevision as number }),
    } as AccountPreferenceMutation
  }
  return {
    namespace,
    field: field as AccountPreferenceField['field'],
    operation,
    ...(operation === 'set' ? { value: raw as string | boolean } : {}),
    ...(row.expectedRevision === undefined ? {} : { expectedRevision: row.expectedRevision as number }),
  } as AccountPreferenceMutation
}
