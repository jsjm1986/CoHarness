import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverOrganizationModels } from '../src/organization-model-settings.ts'
import { isPublicNetworkAddress, NonPublicNetworkTargetError, publicNetworkFetch } from '../src/public-network-fetch.ts'

let server: Server | undefined
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>(resolve => { if (server === undefined) resolve(); else server.close(() => resolve()) })
  server = undefined
})

async function listen(): Promise<{ port: number; requests: () => number }> {
  let requests = 0
  server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'internal-model' }] }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, requests: () => requests }
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = []
  for (let cause = error; cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) chain.push(cause)
  return chain
}

describe('public network fetch', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '255.255.255.255', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
    '64:ff9b::a00:1', '2002:7f00:1::', 'not-an-address',
  ])('classifies %s as non-public', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('classifies %s as public', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true)
  })

  it.each(['127.0.0.1', 'localhost', '[::1]'])('refuses %s before sending a request', async (host) => {
    const { port, requests } = await listen()
    const error = await publicNetworkFetch(new URL(`http://${host}:${String(port)}/v1/models`), { method: 'GET' })
      .then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(NonPublicNetworkTargetError)
    expect(requests()).toBe(0)
  })

  it('keeps model discovery off the loopback listener unless private networks are allowed', async () => {
    const { port, requests } = await listen()
    const baseURL = `http://localhost:${String(port)}`
    const error = await discoverOrganizationModels({ baseURL, api: 'openai-completions', allowPrivateNetwork: false })
      .then(() => undefined, (failure: unknown) => failure)
    expect(causes(error).some(cause => cause instanceof NonPublicNetworkTargetError)).toBe(true)
    expect(requests()).toBe(0)
    await expect(discoverOrganizationModels({ baseURL, api: 'openai-completions', allowPrivateNetwork: true }))
      .resolves.toEqual([{ id: 'internal-model', name: 'internal-model' }])
    expect(requests()).toBe(1)
  })
})
