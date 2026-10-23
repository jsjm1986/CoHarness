/** The real HTTP graph stream keeps idle connections alive and joins their close events. */
import { request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ClientModules from '@deepseek-ai/dsh-client-modules'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Hmr from '../src/index.ts'

async function composition() {
  const ctx = new Context()
  const streams: { destroy: () => void; closed: Promise<void> }[] = []
  onTestFinished(async () => {
    try {
      for (const stream of streams) stream.destroy()
      await ctx.fiber.dispose()
      await Promise.all(streams.map(stream => stream.closed))
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  ctx.baseUrl = new URL('./', import.meta.url).href
  await ctx.plugin(Loader).await()
  ctx.loader.builtins['fixture-webserver'] = WebServer
  ctx.loader.builtins['fixture-client-modules'] = ClientModules
  ctx.loader.builtins['fixture-hmr'] = Hmr
  await ctx.loader.create({ name: 'cordis:fixture-webserver', config: { host: '127.0.0.1', port: 0 } })
  await ctx.loader.create({ name: 'cordis:fixture-client-modules' })
  const id = await ctx.loader.create({ name: 'cordis:fixture-hmr', config: { watchArtifacts: false } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].map(entry => entry.fiber?.state)).toEqual([2, 2, 2])
  const warnings = vi.spyOn(ctx.logger, 'warn')
  const errors = vi.spyOn(ctx.logger, 'error')
  // Native request/close events observe the real carrier without adapting its response methods.
  const server = Reflect.get(ctx.webServer, 'server') as Server
  const origin = ctx.webServer.getOrigin()

  async function open() {
    const accepted = Promise.withResolvers<ServerResponse>()
    const observe = (_request: IncomingMessage, response: ServerResponse): void => { accepted.resolve(response) }
    server.once('request', observe)
    const incoming = Promise.withResolvers<IncomingMessage>()
    const clientErrors: Error[] = []
    const req = request(`${origin}${Hmr.EVENTS_ENDPOINT}`, { agent: false }, (response) => {
      response.on('error', (error: Error) => { clientErrors.push(error) })
      incoming.resolve(response)
    })
    const requestClosed = new Promise<void>((resolve) => { req.once('close', resolve) })
    req.on('error', (error) => { clientErrors.push(error); incoming.reject(error) })
    const stream = {
      destroy: () => { req.destroy(); server.removeListener('request', observe) },
      closed: requestClosed,
    }
    streams.push(stream)
    req.end()
    const response = await incoming.promise
    const serverResponse = await accepted.promise
    let serverDidClose = false
    const serverClosed = new Promise<void>((resolve) => { serverResponse.once('close', () => { serverDidClose = true; resolve() }) })
    const clientClosed = new Promise<void>((resolve) => { response.once('close', resolve) })
    stream.destroy = () => { response.destroy(); req.destroy() }
    stream.closed = Promise.all([requestClosed, clientClosed, serverClosed]).then(() => undefined)
    const iterator = response[Symbol.asyncIterator]()
    let body = ''
    const until = async (text: string): Promise<string> => {
      while (!body.includes(text)) {
        const chunk = await iterator.next()
        if (chunk.done) throw new Error(`graph stream closed before ${JSON.stringify(text)}`)
        body += String(chunk.value)
      }
      return body
    }
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream')
    await until(`data: ${JSON.stringify({ type: 'graph', graph: ctx.clientModules.graph() })}\n\n`)
    return { ...stream, until, clientErrors, serverDidClose: () => serverDidClose }
  }

  return { ctx, open, hmr: ctx.loader.resolve(id), warnings, errors }
}

it('delivers idle comments over real HTTP and clears the shared timer after the final client aborts', async () => {
  const fixture = await composition()
  expect(vi.getTimerCount()).toBe(0)
  const first = await fixture.open()
  const second = await fixture.open()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(15_000)
  const bodies = await Promise.all([first.until(': keep-alive\n\n'), second.until(': keep-alive\n\n')])
  for (const body of bodies) {
    expect(body.match(/^data: /gm)).toHaveLength(1)
    expect(body.match(/^: keep-alive$/gm)).toHaveLength(1)
  }
  first.destroy()
  await first.closed
  expect(vi.getTimerCount()).toBe(1)
  second.destroy()
  await second.closed
  expect(vi.getTimerCount()).toBe(0)
  expect(first.clientErrors).toEqual([])
  expect(second.clientErrors).toEqual([])
  expect(fixture.warnings).not.toHaveBeenCalled()
  expect(fixture.errors).not.toHaveBeenCalled()
})

it('closes an idle native HTTP stream before completing HMR disposal and unregisters its route', async () => {
  const fixture = await composition()
  const stream = await fixture.open()
  expect(vi.getTimerCount()).toBe(1)
  await fixture.hmr.fiber!.dispose()
  expect(stream.serverDidClose()).toBe(true)
  await stream.closed
  expect(vi.getTimerCount()).toBe(0)
  expect(stream.clientErrors.map(error => (error as NodeJS.ErrnoException).code)).toEqual(['ECONNRESET'])
  const response = await fetch(`${fixture.ctx.webServer.getOrigin()}${Hmr.EVENTS_ENDPOINT}`)
  expect(response.status).toBe(404)
  await response.arrayBuffer()
  expect(fixture.warnings).not.toHaveBeenCalled()
  expect(fixture.errors).not.toHaveBeenCalled()
})
