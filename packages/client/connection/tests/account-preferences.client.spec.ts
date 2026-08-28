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
      'ui-conversation': { busyEnter: 'steer' },
    },
    overrides: {
      locale: { preference: 'zh' },
      'ui-theme': { preference: 'dark' },
      'ui-conversation': { busyEnter: 'steer' },
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
})
