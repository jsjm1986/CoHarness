import { describe, expect, it, vi } from 'vitest'
import {
  AccountPreferencesRequestError,
  createBrowserAccountPreferencesTransport,
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
