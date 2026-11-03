/** Native HTTP request completion does not cancel a browser waiting for Inspector startup. */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scheduler } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import * as Inspector from '../src/index.ts'
import { INSPECTOR_BOOTSTRAP_PATH } from '../src/shared/web.ts'

it.each(['completed', 'abandoned'] as const)('owns a %s browser bootstrap across normal request-body completion', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inspector-bootstrap-network-')), ctx = new Context()
  const grant = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<{ request: IncomingMessage; response: ServerResponse }>()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {}), client = new AbortController()
  let connection: Connection.HostConnectionService
  const carrier = createServer((request, response) => {
    request.once('close', () => { closed.resolve({ request, response }) })
    request.resume()
    void connection.dispatchHttp(request, response).then((matched) => { if (!matched) response.writeHead(404).end() })
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  let fiber: ReturnType<Context['plugin']> | undefined, startup: Promise<unknown> | undefined
  let response: Promise<Response> | undefined
  try {
    await ctx.plugin(Credentials, { path: join(root, 'credentials.yaml'), dshHome: root, watch: false })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Connection)
    connection = ctx.connection as Connection.HostConnectionService
    ctx.provide('resourceBudget', { async acquire() {
      entered.resolve(undefined); await grant.promise
      return { signal: new AbortController().signal, release, uncertain }
    } })
    fiber = ctx.plugin(Inspector, { port: 0, captureFetch: false })
    startup = fiber.await().catch((error: unknown) => error)
    await entered.promise
    await new Promise<void>((ready, reject) => { carrier.once('error', reject); carrier.listen(0, '127.0.0.1', ready) })
    const address = carrier.address()
    if (address === null || typeof address === 'string') throw new Error('Bootstrap carrier did not listen')
    const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(address.port)}${INSPECTOR_BOOTSTRAP_PATH}`)
    response = fetch(url, { signal: client.signal })
    const received = response.then(value => ({ value }), (error: unknown) => ({ error }))
    const native = await closed.promise
    await scheduler.yield()
    expect(native.request.complete).toBe(true)
    expect(native.response.headersSent).toBe(false)
    expect(ctx.get('inspector')).toBeUndefined()
    if (mode === 'abandoned') {
      const connectionClosed = new Promise<void>((ready) => { native.response.once('close', ready) })
      client.abort()
      const outcome = await received
      if (!('error' in outcome)) throw new Error('Abandoned browser did not reject')
      expect(outcome.error).toBeInstanceOf(Error)
      await connectionClosed
      await scheduler.yield()
      expect(native.response.destroyed).toBe(true)
      expect(native.response.headersSent).toBe(false)
      expect(native.response.writableEnded).toBe(false)
    }
    grant.resolve(undefined)
    await startup
    expect(ctx.get('inspector')).toBeDefined()
    if (mode === 'completed') {
      const outcome = await received
      expect(outcome).toMatchObject({ value: { status: 200 } })
      if (!('value' in outcome)) throw new Error('Live browser did not receive a response')
      expect(await outcome.value.json()).toHaveProperty('endpoint', expect.stringContaining('/ingest'))
    }
    expect(release).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
  } finally {
    grant.resolve(undefined); client.abort()
    await response?.catch(() => {})
    await startup
    await fiber?.dispose()
    if (carrier.listening) await new Promise<void>((ready) => { carrier.closeAllConnections(); carrier.close(() => { ready() }) })
    try { await ctx.fiber.dispose() } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }) }
  }
})
