import { describe, expect, it, vi } from 'vitest'
import {
  AccountPreferencesRequestError,
  createBrowserAccountPreferencesTransport,
  parseAccountPreferences,
} from '../src/client/account-preferences.ts'

function view(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    revision: 2,
    migrated: true,
    values: {
      locale: { preference: 'zh' },
      'ui-theme': { preference: 'dark' },
      'ui-conversation': {
        busyEnter: 'steer', chatContentWidth: 840, chatFullWidth: true, chatFontSize: 15,
        transcriptView: 'standard', performanceUsage: 'compact', linkOpening: 'new-tab',
      },
    },
    overrides: {
      locale: { preference: 'zh' },
      'ui-theme': { preference: 'dark' },
      'ui-conversation': {
        busyEnter: 'steer', chatContentWidth: 840, chatFullWidth: true, chatFontSize: 15,
        transcriptView: 'standard', performanceUsage: 'compact', linkOpening: 'new-tab',
      },
    },
    ...overrides,
  }
}

describe('account preference browser transport', () => {
  it.each([
    ['fontSize', 10, 22], ['codeFontSize', 10, 16], ['terminalFontSize', 10, 20],
  ] as const)('decodes %s and rejects an invalid effective value or override', (field, min, max) => {
    for (const value of [min, max]) {
      const raw = view(), values = raw.values as Record<string, unknown>, overrides = raw.overrides as Record<string, unknown>
      Object.assign(values['ui-theme'] as object, { [field]: value })
      Object.assign(overrides['ui-theme'] as object, { [field]: value })
      expect(parseAccountPreferences(raw)).toMatchObject({ values: { 'ui-theme': { [field]: value } }, overrides: { 'ui-theme': { [field]: value } } })
    }
    for (const section of ['values', 'overrides']) {
      for (const value of [min - 1, max + 1, min + 0.5, '14', null, true]) {
        const raw = view(), row = raw[section] as Record<string, object>
        Object.assign(row['ui-theme']!, { [field]: value })
        expect(() => parseAccountPreferences(raw)).toThrow('invalid account preferences response')
      }
    }
  })

  it.each(['textFontFamily', 'codeFontFamily', 'terminalFontFamily'] as const)('retains an explicit empty %s and rejects non-string font lists', (field) => {
    const raw = view(), values = raw.values as Record<string, object>, overrides = raw.overrides as Record<string, object>
    Object.assign(values['ui-theme']!, { [field]: '' }); Object.assign(overrides['ui-theme']!, { [field]: '' })
    expect(parseAccountPreferences(raw).overrides['ui-theme']).toHaveProperty(field, '')
    for (const section of ['values', 'overrides']) {
      for (const value of [null, true, 14, [], {}]) {
        const invalid = view(), row = invalid[section] as Record<string, object>
        Object.assign(row['ui-theme']!, { [field]: value })
        expect(() => parseAccountPreferences(invalid)).toThrow('invalid account preferences response')
      }
    }
  })

  it('rejects malformed account responses without treating them as a missing account endpoint', () => {
    const invalid: unknown[] = [null, [], 14, 'wrong endpoint', ...[-1, 0.5, '2', null, 9007199254740992].map(revision => view({ revision })), view({ migrated: 'yes' })]
    for (const [section, namespace, field, value] of [
      ['values', 'locale', 'preference', 'fr'], ['overrides', 'locale', 'preference', 'fr'],
      ['values', 'ui-theme', 'preference', undefined], ['values', 'ui-theme', 'preference', 'automatic'],
      ['overrides', 'ui-theme', 'preference', 'automatic'], ['values', 'ui-conversation', 'busyEnter', 'inject'],
      ['overrides', 'ui-conversation', 'busyEnter', 'inject'], ['values', 'ui-conversation', 'chatFullWidth', 'yes'],
      ['overrides', 'ui-conversation', 'chatFullWidth', 'yes'], ['values', 'ui-conversation', 'transcriptView', 'unknown'],
      ['overrides', 'ui-conversation', 'linkOpening', 'unknown'],
    ] as const) {
      const raw = view(), row = raw[section] as Record<string, object>
      Object.assign(row[namespace]!, { [field]: value }); invalid.push(raw)
    }
    for (const raw of invalid) expect(() => parseAccountPreferences(raw)).toThrow('invalid account preferences response')
  })

  it('resolves omitted account display overrides to their product defaults', () => {
    const raw = view({ values: { locale: {}, 'ui-theme': { preference: 'system' }, 'ui-conversation': { busyEnter: 'queue' } },
      overrides: { locale: {}, 'ui-theme': {}, 'ui-conversation': {} } })
    expect(parseAccountPreferences(raw)).toMatchObject({
      values: { locale: {}, 'ui-theme': { fontSize: 14, codeFontSize: 11, terminalFontSize: 13 },
        'ui-conversation': { chatContentWidth: 748, chatFontSize: 14, chatFullWidth: false, transcriptView: 'detailed' } },
      overrides: { locale: {}, 'ui-theme': {}, 'ui-conversation': {} },
    })
    const explicit = view()
    for (const section of ['values', 'overrides']) {
      const row = explicit[section] as Record<string, object>
      Object.assign(row.locale!, { preference: 'en' })
      Object.assign(row['ui-theme']!, { preference: 'light' })
      Object.assign(row['ui-conversation']!, { busyEnter: 'queue' })
    }
    expect(parseAccountPreferences(explicit)).toMatchObject({ values: { locale: { preference: 'en' }, 'ui-theme': { preference: 'light' } } })
  })

  it('retains caller cancellation on account reads and mutations', async () => {
    const signal = new AbortController().signal
    const fetcher = vi.fn(async () => new Response(JSON.stringify(view()), { headers: { 'content-type': 'application/json' } }))
    const transport = createBrowserAccountPreferencesTransport(fetcher)
    await transport.describe(signal)
    await transport.mutate({ namespace: 'ui-theme', field: 'fontSize', operation: 'set', value: 17 }, signal)
    for (const index of [1, 2]) expect(fetcher).toHaveBeenNthCalledWith(index, '/account/api/preferences', expect.objectContaining({ signal }))
  })

  it('retains HTTP failure status when the server error body is unreadable or has no error code', async () => {
    for (const [body, code] of [
      ['not JSON', undefined], ['{}', undefined],
      ['{"error":"account-preferences-unavailable"}', 'account-preferences-unavailable'],
    ] as const) {
      const transport = createBrowserAccountPreferencesTransport(async () => new Response(body, { status: 500 }))
      await expect(transport.describe()).rejects.toMatchObject({ status: 500, code })
    }
    const transport = createBrowserAccountPreferencesTransport(async () => new Response(null))
    await expect(transport.describe()).rejects.toMatchObject({ status: 501, code: 'account-preferences-unsupported' })
  })

  it('decodes a redacted response and sends a revisioned mutation', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(view()), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(view({ revision: 3 })), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(view({ revision: 4 })), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const transport = createBrowserAccountPreferencesTransport(fetcher)

    await expect(transport.describe()).resolves.toMatchObject({
      revision: 2,
      values: { locale: { preference: 'zh' } },
    })
    await expect(transport.mutate({
      namespace: 'ui-theme', field: 'preference', operation: 'set', value: 'light', expectedRevision: 2,
    })).resolves.toMatchObject({ revision: 3 })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/account/api/preferences', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        namespace: 'ui-theme', field: 'preference', operation: 'set', value: 'light', expectedRevision: 2,
      }),
    }))
    await expect(transport.mutate({
      namespace: 'ui-conversation', field: 'chatContentWidth', operation: 'set', value: 920, expectedRevision: 3,
    })).resolves.toMatchObject({ values: { 'ui-conversation': { chatContentWidth: 840 } } })
    expect(fetcher).toHaveBeenNthCalledWith(3, '/account/api/preferences', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        namespace: 'ui-conversation', field: 'chatContentWidth', operation: 'set', value: 920, expectedRevision: 3,
      }),
    }))
  })

  it('decodes account-owned view preferences and sends their mutations', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(view()), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(view({ revision: 3 })), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const transport = createBrowserAccountPreferencesTransport(fetcher)

    await expect(transport.describe()).resolves.toMatchObject({
      values: {
        'ui-conversation': {
          transcriptView: 'standard', performanceUsage: 'compact', linkOpening: 'new-tab',
        },
      },
    })
    await expect(transport.mutate({
      namespace: 'ui-conversation', field: 'transcriptView', operation: 'set', value: 'verbose', expectedRevision: 2,
    })).resolves.toMatchObject({ revision: 3 })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/account/api/preferences', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        namespace: 'ui-conversation', field: 'transcriptView', operation: 'set', value: 'verbose', expectedRevision: 2,
      }),
    }))
  })

  it('keeps unsupported deployments distinguishable for account-or-host fallback', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }))
    const transport = createBrowserAccountPreferencesTransport(fetcher)
    await expect(transport.describe()).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<AccountPreferencesRequestError>)
  })

  it('rejects a non-JSON successful response as unsupported', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html />', {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    const transport = createBrowserAccountPreferencesTransport(fetcher)
    await expect(transport.describe()).rejects.toMatchObject({
      status: 501,
      code: 'account-preferences-unsupported',
    })
  })

  it('uses display defaults for an older account response and rejects invalid display values', async () => {
    const legacy = view()
    const legacyValues = legacy.values as Record<string, unknown>
    const legacyConversation = legacyValues['ui-conversation'] as Record<string, unknown>
    delete legacyConversation.chatContentWidth
    delete legacyConversation.chatFullWidth
    delete legacyConversation.chatFontSize
    delete legacyConversation.transcriptView
    delete legacyConversation.performanceUsage
    delete legacyConversation.linkOpening
    const legacyFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(legacy), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    await expect(createBrowserAccountPreferencesTransport(legacyFetcher).describe()).resolves.toMatchObject({
      values: {
        'ui-conversation': {
          chatContentWidth: 748, chatFullWidth: false, chatFontSize: 14,
          transcriptView: 'detailed', performanceUsage: 'detailed', linkOpening: 'sidebar',
        },
      },
    })
    const invalidBase = view()
    const invalidValues = invalidBase.values as Record<string, unknown>
    const invalid = view({
      values: {
        ...invalidValues,
        'ui-conversation': { busyEnter: 'queue', chatContentWidth: 99, chatFullWidth: 'yes', chatFontSize: 14 },
      },
    })
    const invalidFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    await expect(createBrowserAccountPreferencesTransport(invalidFetcher).describe()).rejects.toThrow(
      'invalid account preferences response',
    )
    const invalidEnum = view({
      values: {
        ...invalidValues,
        'ui-conversation': {
          busyEnter: 'queue', chatContentWidth: 840, chatFullWidth: true, chatFontSize: 14,
          transcriptView: 'normal',
        },
      },
    })
    const invalidEnumFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(invalidEnum), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    await expect(createBrowserAccountPreferencesTransport(invalidEnumFetcher).describe()).rejects.toThrow(
      'invalid account preferences response',
    )
    const invalidOverrides = view({
      overrides: {
        ...(view().overrides as Record<string, unknown>),
        'ui-conversation': { performanceUsage: 'lots' },
      },
    })
    const invalidOverridesFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(invalidOverrides), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    await expect(createBrowserAccountPreferencesTransport(invalidOverridesFetcher).describe()).rejects.toThrow(
      'invalid account preferences response',
    )
  })
})
