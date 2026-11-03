/** External Cloudflare replies are parsed before their fields become persistent identifiers. */
import { describe, expect, it, vi } from 'vitest'
import { CloudflareApiError, createTunnel, resolveAccount } from '../src/cloudflare-api.ts'

describe('Cloudflare API responses', () => {
  it('accepts the documented create response without an embedded run token', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ success: true, errors: [], result: { id: 'tunnel-1' } })))
    await expect(createTunnel(request, 'synthetic-token', 'account-1', 'fixture')).resolves.toEqual({ id: 'tunnel-1' })
  })

  it.each([null, {}, { success: true, errors: [], result: null }, { success: true, errors: [], result: [{}] }])(
    'rejects malformed remote fields as an API failure (%j)', async reply => {
      const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(reply)))
      await expect(resolveAccount(request, 'synthetic-token')).rejects.toBeInstanceOf(CloudflareApiError)
    },
  )

  it('rejects a failing HTTP status even when the body claims success', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ success: true, errors: [], result: [{ id: 'account-1', name: 'fixture' }] }), { status: 502 }))
    await expect(resolveAccount(request, 'synthetic-token')).rejects.toMatchObject({ code: 'api-failed' })
  })
})
