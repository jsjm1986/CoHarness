/**
 * Minimal Cloudflare API v4 client for the administrator-managed named tunnel:
 * account and zone resolution, remotely-configured tunnel creation, and the
 * CNAME that points a hostname at it. Every call takes the administrator's API
 * token explicitly; nothing is cached at module scope.
 */
const CF_API = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 20_000

/** The Cloudflare API rejected a call; `detail` carries its first error message. */
export class CloudflareApiError extends Error {
  constructor(readonly code: 'unauthorized' | 'not-found' | 'conflict' | 'api-failed', message: string) {
    super(message)
  }
}

interface CfEnvelope<T> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T
}

async function call<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  path: string,
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
  let envelope: CfEnvelope<T>
  try {
    envelope = await response.json() as CfEnvelope<T>
  } catch {
    throw new CloudflareApiError('api-failed', `Cloudflare API returned HTTP ${response.status} with a non-JSON body`)
  }
  if (!envelope.success) {
    const detail = envelope.errors[0]?.message ?? `HTTP ${response.status}`
    if (response.status === 401 || response.status === 403) throw new CloudflareApiError('unauthorized', detail)
    if (response.status === 404) throw new CloudflareApiError('not-found', detail)
    if (response.status === 409) throw new CloudflareApiError('conflict', detail)
    throw new CloudflareApiError('api-failed', detail)
  }
  return envelope.result
}

/** Resolve the first account the API token can see. */
export async function resolveAccount(fetchImpl: typeof fetch, token: string): Promise<{ id: string; name: string }> {
  const accounts = await call<Array<{ id: string; name: string }>>(fetchImpl, token, 'GET', '/accounts')
  const account = accounts[0]
  if (account === undefined) {
    throw new CloudflareApiError('not-found', 'the API token cannot see any Cloudflare account')
  }
  return account
}

/** Resolve the active zone for a registrable domain like `example.com`. */
export async function resolveZone(fetchImpl: typeof fetch, token: string, domain: string): Promise<{ id: string; name: string }> {
  const zones = await call<Array<{ id: string; name: string }>>(fetchImpl, token, 'GET',
    `/zones?name=${encodeURIComponent(domain)}&status=active`)
  const zone = zones[0]
  if (zone === undefined) {
    throw new CloudflareApiError('not-found', `no active Cloudflare zone named ${domain}`)
  }
  return zone
}

/**
 * Create a remotely-configured tunnel and return its id plus the run token
 * cloudflared consumes (`tunnel run --token`). `config_src: 'cloudflare'`
 * makes the ingress configurable through the API rather than a local file.
 */
export async function createTunnel(
  fetchImpl: typeof fetch,
  token: string,
  accountId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const tunnel = await call<{ id: string; token?: string }>(fetchImpl, token, 'POST',
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
    { name, config_src: 'cloudflare' })
  if (tunnel.token === undefined || tunnel.token === '') {
    throw new CloudflareApiError('api-failed', 'Cloudflare did not return a tunnel run token')
  }
  return { id: tunnel.id, token: tunnel.token }
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
  await call<unknown>(fetchImpl, token, 'PUT',
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
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
  const existing = await call<Array<{ id: string }>>(fetchImpl, token, 'GET',
    `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`)
  const record = existing[0]
  if (record !== undefined) {
    await call<unknown>(fetchImpl, token, 'PUT',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
      { type: 'CNAME', name: hostname, content, proxied: true })
    return
  }
  await call<unknown>(fetchImpl, token, 'POST',
    `/zones/${encodeURIComponent(zoneId)}/dns_records`,
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
  const existing = await call<Array<{ id: string; content: string }>>(fetchImpl, token, 'GET',
    `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`)
  const record = existing.find(entry => entry.content === `${tunnelId}.cfargotunnel.com`)
  if (record === undefined) return
  await call<unknown>(fetchImpl, token, 'DELETE',
    `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`)
}

/** Delete the Cloudflare-side tunnel object (connections must already be down). */
export async function deleteTunnel(
  fetchImpl: typeof fetch,
  token: string,
  accountId: string,
  tunnelId: string,
): Promise<void> {
  await call<unknown>(fetchImpl, token, 'DELETE',
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`)
}
