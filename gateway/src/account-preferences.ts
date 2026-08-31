import type { UserRow } from './auth.ts'

/** Namespaces whose values follow an authenticated account across runtimes. */
export type AccountPreferenceNamespace = 'locale' | 'ui-theme' | 'ui-conversation'

/** Fields accepted for each account preference namespace. */
export type AccountPreferenceField =
  | { namespace: 'locale'; field: 'preference' }
  | { namespace: 'ui-theme'; field: 'preference' }
  | { namespace: 'ui-conversation'; field: 'busyEnter' | 'chatContentWidth' | 'chatFontSize' }

/** Account-owned transcript width limits shared by the browser controls. */
export const ACCOUNT_CHAT_CONTENT_WIDTH_RANGE = { min: 560, max: 1080 } as const

/** Account-owned transcript font-size limits shared by the browser controls. */
export const ACCOUNT_CHAT_FONT_SIZE_RANGE = { min: 12, max: 17 } as const

/** Default transcript width when an account has no explicit override. */
export const DEFAULT_ACCOUNT_CHAT_CONTENT_WIDTH = 748

/** Default transcript font size when an account has no explicit override. */
export const DEFAULT_ACCOUNT_CHAT_FONT_SIZE = 14

/** Effective account preferences returned to browser clients. */
export interface AccountPreferenceValues {
  locale: { preference?: 'zh' | 'en' }
  'ui-theme': { preference: 'light' | 'dark' | 'system' }
  'ui-conversation': {
    busyEnter: 'queue' | 'steer'
    chatContentWidth: number
    chatFontSize: number
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
    'ui-theme': { preference?: 'light' | 'dark' | 'system' }
    'ui-conversation': {
      busyEnter?: 'queue' | 'steer'
      chatContentWidth?: number
      chatFontSize?: number
    }
  }
  /** Whether the account row has been migrated from the legacy settings file. */
  migrated: boolean
}

/** One narrow account preference mutation. */
export type AccountPreferenceMutation = AccountPreferenceField & {
  operation: 'set' | 'unset'
  value?: string | number
  expectedRevision?: number
}

/** Account preference persistence consumed by the Gateway HTTP server. */
export interface GatewayAccountPreferencesService {
  describe(user: UserRow): Promise<AccountPreferencesView>
  mutate(user: UserRow, mutation: AccountPreferenceMutation): Promise<AccountPreferencesView>
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
  'ui-theme': { preference: 'system' },
  'ui-conversation': {
    busyEnter: 'queue',
    chatContentWidth: DEFAULT_ACCOUNT_CHAT_CONTENT_WIDTH,
    chatFontSize: DEFAULT_ACCOUNT_CHAT_FONT_SIZE,
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
    ? field === 'busyEnter' || field === 'chatContentWidth' || field === 'chatFontSize'
    : field === 'preference'
  if (!validField) throw new AccountPreferencesInputError('unsupported account preference field')
  if (operation !== 'set' && operation !== 'unset') {
    throw new AccountPreferencesInputError('account preference operation must be set or unset')
  }
  assertPreferenceRevision(row.expectedRevision)
  const raw = row.value
  const numericConversationField = namespace === 'ui-conversation'
    && (field === 'chatContentWidth' || field === 'chatFontSize')
  if (operation === 'set' && numericConversationField
    && typeof raw !== 'number' && typeof raw !== 'string') {
    throw new AccountPreferencesInputError('conversation display preference requires a number')
  }
  if (operation === 'set' && !numericConversationField && typeof raw !== 'string') {
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
  if (numericConversationField && operation === 'set') {
    const numberValue = typeof raw === 'number' ? raw : Number(raw)
    const range = field === 'chatContentWidth'
      ? ACCOUNT_CHAT_CONTENT_WIDTH_RANGE
      : ACCOUNT_CHAT_FONT_SIZE_RANGE
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
    ...(operation === 'set' ? { value: raw as string } : {}),
    ...(row.expectedRevision === undefined ? {} : { expectedRevision: row.expectedRevision as number }),
  } as AccountPreferenceMutation
}
