/** Real WebSocket connections exercise route withdrawal and provider-operation drain through Cordis. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { RemoteDesktopToken } from '@deepseek-ai/dsh-remote-desktop'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import * as streamMount from '../src/index.ts'

async function fixture(serveStream: (token: RemoteDesktopToken, socket: Duplex, signal?: AbortSignal) => Promise<void>) {
  const ctx = new Context(), server = createServer(), clients = new Set<WebSocket>()
  let route: WebUpgradeRoute | undefined
  ctx.provide('remoteDesktop', { serveStream } as never)
  ctx.provide('webServer', { registerUpgrade(next: WebUpgradeRoute) {
    if (route !== undefined) throw new Error('The fixture already has an upgrade route')
    route = next
    return () => { route = undefined }
  } } as never)
  server.on('upgrade', (request, socket, head) => {
    if (route === undefined) socket.destroy()
    else void route.handler(request, socket, head)
  })
  const close = async () => {
    const closures = [...clients].filter(client => client.readyState !== WebSocket.CLOSED).map((client) => {
      const closed = new Promise<void>((resolve) => { client.once('close', () => { resolve() }) })
      client.terminate(); return closed
    })
    await Promise.all(closures)
    await ctx.fiber.dispose()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('The fixture has no listener address')
    const fiber = await ctx.plugin(streamMount)
    return {
      fiber, get registered() { return route !== undefined },
      connect(query = '?token=fixture-token') {
        const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/remote-desktop/stream${query}`)
        clients.add(client)
        client.on('error', () => { /* Failed and refused handshakes are asserted through their close event. */ })
        return client
      },
      async [Symbol.asyncDispose]() { await close() },
    }
  } catch (error) { await close(); throw error }
}

describe('remote desktop stream lifetime', () => {
  it('withdraws upgrades, closes clients and waits for the accepted provider operation', async () => {
    const entered = Promise.withResolvers<{ token: RemoteDesktopToken; socket: Duplex; signal?: AbortSignal }>()
    const aborted = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let calls = 0
    await using owner = await fixture(async (token, socket, signal) => {
      calls += 1
      signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve({ token, socket, ...(signal === undefined ? {} : { signal }) })
      await release.promise
    })
    const client = owner.connect(), clientClosed = new Promise<void>((resolve) => { client.once('close', () => { resolve() }) })
    let closing: Promise<void> | undefined, closed = false
    try {
      await once(client, 'open')
      const operation = await entered.promise
      expect(String(operation.token)).toBe('fixture-token')
      expect(operation.signal).toBeDefined()
      closing = owner.fiber.dispose().then(() => { closed = true })
      await aborted.promise
      await clientClosed
      expect(owner.registered).toBe(false)
      expect(operation.socket.destroyed).toBe(true)
      expect(closed).toBe(false)
      const refused = owner.connect()
      await new Promise<void>((resolve) => { refused.once('close', () => { resolve() }) })
      expect(calls).toBe(1)
      release.resolve(undefined)
      await closing
      expect(operation.signal?.aborted).toBe(true)
    } finally { release.resolve(undefined); await closing }
  })

  it('preserves the exact token and binary traffic during normal operation', async () => {
    const served = Promise.withResolvers<{ token: RemoteDesktopToken; socket: Duplex }>()
    await using owner = await fixture(async (token, socket) => {
      served.resolve({ token, socket })
      socket.on('data', (bytes: Buffer) => { socket.write(bytes) })
      await new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    })
    const client = owner.connect('?token=opaque-token-123')
    await once(client, 'open')
    const operation = await served.promise
    const message = new Promise<{ bytes: unknown; binary: boolean }>((resolve) => {
      client.once('message', (bytes, binary) => { resolve({ bytes, binary }) })
    })
    client.send(Buffer.from([0, 4, 5, 255]))
    const { bytes, binary } = await message
    expect(String(operation.token)).toBe('opaque-token-123')
    expect(binary).toBe(true)
    expect(bytes).toEqual(Buffer.from([0, 4, 5, 255]))
    await owner.fiber.dispose()
    expect(operation.socket.destroyed).toBe(true)
  })

  it('does not invoke the provider for a missing token', async () => {
    let calls = 0
    await using owner = await fixture(async () => { calls += 1 })
    const client = owner.connect('')
    await new Promise<void>((resolve) => { client.once('close', () => { resolve() }) })
    expect(calls).toBe(0)
    await owner.fiber.dispose()
    expect(owner.registered).toBe(false)
  })
})
