/** Browser transport for account-scoped UI preferences. */

import { readApiResponseJson } from '@deepseek-ai/dsh-host-apiproxy/client'

/** Account preference namespace accepted by the Gateway. */
export type AccountPreferenceNamespace = 'locale' | 'ui-theme' | 'ui-conversation'

/** One validated account preference response. */
export interface AccountPreferencesView {
  revision: number
  values: {
    locale: { preference?: 'zh' | 'en' }
    'ui-theme': { preference: 'light' | 'dark' | 'system' }
    'ui-conversation': { busyEnter: 'queue' | 'steer' }
  }
  overrides: {
    locale: { preference?: 'zh' | 'en' }
    'ui-theme': { preference?: 'light' | 'dark' | 'system' }
    'ui-conversation': { busyEnter?: 'queue' | 'steer' }
  }
  migrated: boolean
}

/** Narrow account preference mutation sent to the Gateway. */
export interface AccountPreferenceMutation {
  namespace: AccountPreferenceNamespace
  field: 'preference' | 'busyEnter'
  operation: 'set' | 'unset'
  value?: string
  expectedRevision?: number
}

/** HTTP transport used by the settings scope binder. */
export interface AccountPreferencesTransport {
  describe(signal?: AbortSignal): Promise<AccountPreferencesView>
  mutate(mutation: AccountPreferenceMutation, signal?: AbortSignal): Promise<AccountPreferencesView>
}

/** Error retaining the Gateway status and machine-readable error code. */
export class AccountPreferencesRequestError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(code ?? `account preferences request failed with status ${String(status)}`)
    this.name = 'AccountPreferencesRequestError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid account preferences response')
  }
  return value as Record<string, unknown>
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid account preferences response')
  }
  return value
}

function optionalLocale(value: unknown): { preference?: 'zh' | 'en' } {
  const row = object(value)
  if (row.preference !== undefined && row.preference !== 'zh' && row.preference !== 'en') {
    throw new Error('invalid account preferences response')
  }
  return row.preference === undefined ? {} : { preference: row.preference }
}

function optionalTheme(value: unknown): { preference?: 'light' | 'dark' | 'system' } {
  const row = object(value)
  if (row.preference !== undefined && row.preference !== 'light' && row.preference !== 'dark' && row.preference !== 'system') {
    throw new Error('invalid account preferences response')
  }
  return row.preference === undefined ? {} : { preference: row.preference }
}

function optionalBusyEnter(value: unknown): { busyEnter?: 'queue' | 'steer' } {
  const row = object(value)
  if (row.busyEnter !== undefined && row.busyEnter !== 'queue' && row.busyEnter !== 'steer') {
    throw new Error('invalid account preferences response')
  }
  return row.busyEnter === undefined ? {} : { busyEnter: row.busyEnter }
}

function theme(value: unknown): { preference: 'light' | 'dark' | 'system' } {
  const row = object(value)
  if (row.preference !== 'light' && row.preference !== 'dark' && row.preference !== 'system') {
    throw new Error('invalid account preferences response')
  }
  return { preference: row.preference }
}

function busyEnter(value: unknown): { busyEnter: 'queue' | 'steer' } {
  const row = object(value)
  if (row.busyEnter !== 'queue' && row.busyEnter !== 'steer') {
    throw new Error('invalid account preferences response')
  }
  return { busyEnter: row.busyEnter }
}

/** Decode a Gateway account preference response at the browser trust boundary.
 * @param value - untrusted JSON response.
 * @returns the validated account preference view.
 */
export function parseAccountPreferences(value: unknown): AccountPreferencesView {
  const root = object(value)
  const values = object(root.values)
  if (typeof root.migrated !== 'boolean') throw new Error('invalid account preferences response')
  return {
    revision: revision(root.revision),
    values: {
      locale: optionalLocale(values.locale),
      'ui-theme': theme(values['ui-theme']),
      'ui-conversation': busyEnter(values['ui-conversation']),
    },
    overrides: {
      locale: optionalLocale(object(root.overrides).locale),
      'ui-theme': optionalTheme(object(root.overrides)['ui-theme']),
      'ui-conversation': optionalBusyEnter(object(root.overrides)['ui-conversation']),
    },
    migrated: root.migrated,
  }
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = object(await readApiResponseJson(response))
    return typeof body.error === 'string' ? body.error : undefined
  } catch (_invalidErrorResponse) {
    return undefined
  }
}

async function request(
  fetcher: typeof fetch,
  init: RequestInit,
  parse: (value: unknown) => AccountPreferencesView,
): Promise<AccountPreferencesView> {
  const response = await fetcher('/account/api/preferences', {
    credentials: 'same-origin',
    ...init,
  })
  if (!response.ok) throw new AccountPreferencesRequestError(response.status, await errorCode(response))
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('json')) {
    // Standalone dsh web servers do not mount Gateway account routes and may
    // answer an SPA shell with 200. Treat that exact capability miss as a
    // fallback signal; genuine JSON/HTTP failures remain visible to the UI.
    throw new AccountPreferencesRequestError(501, 'account-preferences-unsupported')
  }
  return parse(await readApiResponseJson(response))
}

/** Create the same-origin account preference transport used by the Web app.
 * @param fetcher - HTTP function used for same-origin requests.
 * @returns the account preference transport.
 */
export function createBrowserAccountPreferencesTransport(
  fetcher: typeof fetch = globalThis.fetch,
): AccountPreferencesTransport {
  return {
    describe: signal => request(fetcher, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    }, parseAccountPreferences),
    mutate: (mutation, signal) => request(fetcher, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation),
      ...(signal === undefined ? {} : { signal }),
    }, parseAccountPreferences),
  }
}
