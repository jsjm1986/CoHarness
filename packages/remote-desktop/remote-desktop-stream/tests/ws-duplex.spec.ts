/**
 * `WebSocketDuplex` over a real `ws` connection on an ephemeral loopback
 * listener: binary frames flow in both directions, a text frame fails closed
 * with 1003, and teardown propagates in both directions. Every fixture owns
 * its port and closes the server, the socket pair, and the client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { WebSocketDuplex } from '../src/ws-duplex.ts'

interface Fixture {
  duplex: WebSocketDuplex
  client: WebSocket
  wss: WebSocketServer
  server: Server
}

describe('WebSocketDuplex', () => {
  const fixtures: Fixture[] = []

  afterEach(async () => {
    while (fixtures.length > 0) {
      const { duplex, client, wss, server } = fixtures.pop()!
      duplex.destroy()
      client.terminate()
      wss.close()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  async function spawn(): Promise<Fixture> {
    const server = createServer()
    const wss = new WebSocketServer({ server })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    const connected = new Promise<WebSocketDuplex>((resolve) => {
      wss.once('connection', (ws) => { resolve(new WebSocketDuplex(ws)) })
    })
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    await once(client, 'open')
    const fixture: Fixture = { duplex: await connected, client, wss, server }
    fixtures.push(fixture)
    return fixture
  }

  it('pipes binary frames in both directions', async () => {
    const { duplex, client } = await spawn()
    const inbound: Buffer[] = []
    duplex.on('data', (chunk: Buffer) => { inbound.push(chunk) })
    client.send(Buffer.from([1, 2, 3]))
    client.send(Buffer.from([4, 5]))
    await vi.waitFor(() => { expect(Buffer.concat(inbound).equals(Buffer.from([1, 2, 3, 4, 5]))).toBe(true) })

    const echoed = once(client, 'message')
    await new Promise<void>((resolve, reject) => {
      duplex.write(Buffer.from([9, 8]), (error?: Error | null) => {
        if (error) reject(error)
        else resolve()
      })
    })
    const [data] = (await echoed) as [Buffer | ArrayBuffer | Buffer[], boolean]
    expect(Buffer.from(data as Buffer).equals(Buffer.from([9, 8]))).toBe(true)
  })

  it('fails closed on a text frame', async () => {
    const { duplex, client } = await spawn()
    const closed = once(client, 'close')
    client.send('text frame')
    const [code] = (await closed) as [number]
    expect(code).toBe(1003)
    await vi.waitFor(() => { expect(duplex.destroyed).toBe(true) })
  })

  it('closes the socket when the stream is destroyed', async () => {
    const { duplex, client } = await spawn()
    const closed = once(client, 'close')
    duplex.destroy()
    await closed
  })

  it('destroys the stream when the socket closes', async () => {
    const { duplex, client } = await spawn()
    client.terminate()
    await vi.waitFor(() => { expect(duplex.destroyed).toBe(true) })
  })
})
