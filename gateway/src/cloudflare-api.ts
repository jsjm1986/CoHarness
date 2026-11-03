/**
 * Minimal Cloudflare API v4 client for the administrator-managed named tunnel:
 * account and zone resolution, remotely-configured tunnel creation, and the
 * CNAME that points a hostname at it. Every call takes the administrator's API
 * token explicitly; nothing is cached at module scope.
 */
import { z } from 'zod'

const CF_API = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 20_000

/** The Cloudflare API rejected a call; `detail` carries its first error message. */
export class CloudflareApiError extends Error {
  constructor(readonly code: 'unauthorized' | 'not-found' | 'conflict' | 'api-failed', message: string) {
    super(message)
  }
}

const identifier = z.string().min(1)
const envelopeSchema = z.object({
  success: z.boolean(), errors: z.array(z.object({ message: z.string() })).default([]), result: z.unknown(),
})

async function call<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  path: string,
  resultSchema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(`${CF_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new CloudflareApiError('api-failed', `Cloudflare API request failed: ${String(error)}`)
  }
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new CloudflareApiError('api-failed', `Cloudflare API returned HTTP ${response.status} with a non-JSON body`)
  }
  const parsed = envelopeSchema.safeParse(value)
  if (!parsed.success) throw new CloudflareApiError('api-failed', 'Cloudflare API returned invalid response fields')
  const envelope = parsed.data
  if (!response.ok || !envelope.success) {
    const detail = envelope.errors[0]?.message ?? `HTTP ${response.status}`
    if (response.status === 401 || response.status === 403) throw new CloudflareApiError('unauthorized', detail)
    if (response.status === 404) throw new CloudflareApiError('not-found', detail)
    if (response.status === 409) throw new CloudflareApiError('conflict', detail)
    throw new CloudflareApiError('api-failed', detail)
  }
  const result = resultSchema.safeParse(envelope.result)
  if (!result.success) throw new CloudflareApiError('api-failed', 'Cloudflare API returned invalid result fields')
  return result.data
}

/** Resolve the first account the API token can see. */
export async function resolveAccount(fetchImpl: typeof fetch, token: string): Promise<{ id: string; name: string }> {
  const accounts = await call(fetchImpl, token, 'GET', '/accounts', z.array(z.object({ id: identifier, name: z.string() })))
  const account = accounts[0]
  if (account === undefined) {
    throw new CloudflareApiError('not-found', 'the API token cannot see any Cloudflare account')
  }
  return account
}

/**
 * Resolve the active zone and its owning account for a domain like `example.com`.
 * @param fetchImpl - configured HTTP transport.
 * @param token - administrator's Cloudflare API credential.
 * @param domain - canonical DNS zone name.
 * @returns validated zone id, name and account id.
 */
export async function resolveZone(fetchImpl: typeof fetch, token: string, domain: string): Promise<{ id: string; name: string; accountId: string }> {
  const zones = await call(fetchImpl, token, 'GET',
    `/zones?name=${encodeURIComponent(domain)}&status=active`,
    z.array(z.object({ id: identifier, name: z.string(), account: z.object({ id: identifier }) })))
  const zone = zones[0]
  if (zone === undefined) {
    throw new CloudflareApiError('not-found', `no active Cloudflare zone named ${domain}`)
  }
  return { id: zone.id, name: zone.name, accountId: zone.account.id }
}

/**
 * Create a remotely-configured tunnel and return its id. `config_src: 'cloudflare'`
 * makes the ingress configurable through the API rather than a local file.
 * @param fetchImpl - configured HTTP transport.
 * @param token - administrator's Cloudflare API credential.
 * @param accountId - account that owns the selected zone.
 * @param name - stable administrator-facing tunnel name.
 * @returns acknowledged tunnel id; retrieve the connector token separately.
 */
export async function createTunnel(
  fetchImpl: typeof fetch,
  token: string,
  accountId: string,
  name: string,
): Promise<{ id: string }> {
  return call(fetchImpl, token, 'POST',
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, z.object({ id: identifier }),
    { name, config_src: 'cloudflare' })
}

/**
 * Retrieve the private connector token after the created tunnel id is durable.
 * @param fetchImpl - configured HTTP transport.
 * @param token - administrator's Cloudflare API credential.
 * @param accountId - account that owns the selected zone and tunnel.
 * @param tunnelId - previously created tunnel id.
 * @returns nonempty connector credential for cloudflared.
 */
export async function getTunnelToken(fetchImpl: typeof fetch, token: string, accountId: string, tunnelId: string): Promise<string> {
  return call(fetchImpl, token, 'GET', `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`, z.string().min(1))
}

/** Push the ingress: `hostname` proxies to the local service, everything else 404s. */
export async function configureTunnel(
  fetchImpl: typeof fetch,
  token: string,
  accountId: string,
  tunnelId: string,
  hostname: string,
  service: string,
): Promise<void> {
  await call(fetchImpl, token, 'PUT',
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, z.unknown(),
    { config: { ingress: [{ hostname, service }, { service: 'http_status:404' }] } })
}

/** Point `hostname` at the tunnel, creating or replacing its CNAME. */
export async function upsertTunnelDns(
  fetchImpl: typeof fetch,
  token: string,
  zoneId: string,
  hostname: string,
  tunnelId: string,
): Promise<void> {
  const content = `${tunnelId}.cfargotunnel.com`
  const existing = await call(fetchImpl, token, 'GET',
    `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`, z.array(z.object({ id: identifier })))
  const record = existing[0]
  if (record !== undefined) {
    await call(fetchImpl, token, 'PUT',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`, z.unknown(),
      { type: 'CNAME', name: hostname, content, proxied: true })
    return
  }
  await call(fetchImpl, token, 'POST',
    `/zones/${encodeURIComponent(zoneId)}/dns_records`, z.unknown(),
    { type: 'CNAME', name: hostname, content, proxied: true })
}

/** Remove the tunnel's CNAME for `hostname` when it points at this tunnel. */
export async function deleteTunnelDns(
  fetchImpl: typeof fetch,
  token: string,
  zoneId: string,
  hostname: string,
  tunnelId: string,
): Promise<void> {
  const existing = await call(fetchImpl, token, 'GET',
    `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    z.array(z.object({ id: identifier, content: z.string() })))
  const record = existing.find(entry => entry.content === `${tunnelId}.cfargotunnel.com`)
  if (record === undefined) return
  await call(fetchImpl, token, 'DELETE',
    `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`, z.unknown())
}

/** Delete the Cloudflare-side tunnel object (connections must already be down). */
export async function deleteTunnel(
  fetchImpl: typeof fetch,
  token: string,
  accountId: string,
  tunnelId: string,
): Promise<void> {
  await call(fetchImpl, token, 'DELETE',
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`, z.unknown())
}
