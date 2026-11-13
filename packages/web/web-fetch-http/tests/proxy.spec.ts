import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import { publicHttpNetwork, resolvePublicAddresses } from '../src/network.ts'

const limits: HttpFetchLimits = {
  maxUrlLength: 2048,
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
}

/** Absolute-form targets the fake proxy saw; a populated entry proves the hop was tunnelled. */
let proxied: string[]
let proxy: Server
let origin: Server
let proxyUrl: string
let originUrl: string

/**
 * The target for every assertion about a tunnelled hop. Loopback cannot serve: no policy routes
 * this machine through a proxy. The proxy answers the absolute-form request, so the host needs only
 * a stubbed public answer from the local resolver.
 */
const proxyTarget = 'http://origin.test/page'
const publicAnswer = [{ address: '93.184.216.34', family: 4 as const }]
let disposeProxy: (() => Promise<void>) | undefined

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
}

function respond(_request: IncomingMessage, response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(body)
}

beforeEach(async () => {
  proxied = []
  proxy = createServer((request, response) => {
    proxied.push(request.url ?? '')
    respond(request, response, 'via-proxy')
  })
  origin = createServer((request, response) => { respond(request, response, 'direct') })
  const [proxyAddress, originAddress] = await Promise.all([listen(proxy), listen(origin)])
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
  originUrl = `http://127.0.0.1:${String(originAddress.port)}/page`
})

afterEach(async () => {
  await disposeProxy?.()
  disposeProxy = undefined
  vi.restoreAllMocks()
  await Promise.all([
    new Promise<void>((resolve) => { proxy.close(() => { resolve() }) }),
    new Promise<void>((resolve) => { origin.close(() => { resolve() }) }),
  ])
})

/**
 * Install the policy of a user who exported one proxy for both schemes; the fixture disposes it
 * after every case.
 */
async function installProxy(): Promise<() => Promise<void>> {
  const env = { get: (name: string) => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
  return await installProxyFromEnvironment(env, () => undefined)
}

describe('fetching through a proxy', () => {
  it('validates the hostname locally, then tunnels the request without pinning', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve').mockResolvedValue(publicAnswer)
    const pinned = vi.spyOn(publicHttpNetwork, 'request')
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits).fetch({ url: proxyTarget })

    expect(result.body.content).toBe('via-proxy')
    expect(proxied).toEqual([proxyTarget])
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve.mock.calls[0]?.[0]).toBe('origin.test')
    expect(pinned).not.toHaveBeenCalled()
  })

  it.each(['10.0.0.1', '169.254.169.254', '127.0.0.1'])(
    'refuses a hostname that resolves to %s before the proxy receives it',
    async (address) => {
      // The real resolver checks the stubbed lookup answer, so the refusal is the production one.
      const lookup = vi.fn().mockResolvedValue([{ address, family: 4 }])
      vi.spyOn(publicHttpNetwork, 'resolve').mockImplementation(async (hostname, signal) =>
        await resolvePublicAddresses(hostname, signal, lookup))
      disposeProxy = await installProxy()

      await expect(new HttpFetchProvider(limits).fetch({ url: 'http://metadata.internal.test/latest' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
      expect(lookup).toHaveBeenCalledOnce()
      expect(proxied).toEqual([])
    },
  )

  it('refuses a hostname the local resolver cannot answer instead of letting the proxy resolve it', async () => {
    vi.spyOn(publicHttpNetwork, 'resolve').mockImplementation(async (hostname, signal) =>
      await resolvePublicAddresses(hostname, signal, () => Promise.resolve([])))
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: 'http://jenkins.corp.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(proxied).toEqual([])
  })

  it('keeps resolving and pinning a hop the policy does not proxy', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    // No bypass entry needed: a resolved policy never routes loopback through a proxy, which is
    // exactly the case this asserts still resolves and pins.
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits).fetch({ url: originUrl })

    expect(result.body.content).toBe('direct')
    expect(proxied).toEqual([])
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('resolves and pins when no proxy is installed', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    const result = await new HttpFetchProvider(limits).fetch({ url: originUrl })

    expect(result.body.content).toBe('direct')
    expect(resolve).toHaveBeenCalledOnce()
  })

  it.each(['10.0.0.5', '169.254.169.254', '127.0.0.2'])(
    'refuses %s instead of letting the proxy reach it for us',
    async (host) => {
      const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      disposeProxy = await installProxy()

      // A literal reaches the same resolver as a hostname, which refuses it without a DNS query.
      await expect(new HttpFetchProvider(limits).fetch({ url: `http://${host}:8080/` }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
      expect(proxied).toEqual([])
      expect(resolve).toHaveBeenCalledOnce()
    },
  )

  it('still refuses a cross-origin redirect on the proxied path', async () => {
    proxy.removeAllListeners('request')
    proxy.on('request', (request, response) => {
      proxied.push(request.url ?? '')
      response.writeHead(302, { location: 'http://elsewhere.example/next' })
      response.end()
    })
    vi.spyOn(publicHttpNetwork, 'resolve').mockResolvedValue(publicAnswer)
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: proxyTarget }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('still refuses a URL the transport policy rejects before any hop', async () => {
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: 'ftp://example.com/x' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(proxied).toEqual([])
  })
})
