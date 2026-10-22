import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createTransport } from '../src/transport.ts'

const servers: Server[] = []
const transports: ReturnType<typeof createTransport>[] = []

afterEach(async () => {
  await Promise.all(transports.splice(0).map(async (transport) => { await transport.close() }))
  await Promise.all(servers.splice(0).map(async (server) => {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    })
  }))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('MCP fixture did not bind TCP')
  return `http://127.0.0.1:${String(address.port)}/mcp`
}

function transport(url: string): ReturnType<typeof createTransport> {
  const result = createTransport({
    transport: 'streamable-http',
    serverName: 'redirect-test',
    url,
    headers: { 'x-api-key': 'synthetic-test-key' },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  })
  transports.push(result)
  return result
}

describe('HTTP MCP request destinations', () => {
  it.each([307, 308])('rejects a cross-origin %s before forwarding headers or the body', async (status) => {
    let redirectedRequests = 0
    const destination = await listen(createServer((request, response) => {
      redirectedRequests += 1
      request.resume()
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
    }))
    const origin = await listen(createServer((request, response) => {
      request.resume()
      response.writeHead(status, { Location: destination }).end()
    }))
    const client = transport(origin)
    await client.start()

    await expect(client.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow()
    expect(redirectedRequests).toBe(0)
  })

  it('sends configured headers to the configured destination', async () => {
    const keys: Array<string | undefined> = []
    const destination = await listen(createServer((request, response) => {
      keys.push(request.headers['x-api-key'] as string | undefined)
      request.resume()
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
    }))
    const client = transport(destination)
    await client.start()

    await client.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(keys).toEqual(['synthetic-test-key'])
  })
})
