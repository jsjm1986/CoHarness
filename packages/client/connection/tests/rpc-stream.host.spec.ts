/** Real HTTP read streams preserve order, refusal, cancellation and awaited cleanup. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { createRpcStreamHttpHandler, type ConnectionRpcStreamHandler } from '../src/rpc-stream-host.ts'
import { readRpcStream } from '../src/rpc-stream-reader.ts'

async function fixture(handler: ConnectionRpcStreamHandler) {
  const adapter = createRpcStreamHttpHandler(handler)
  const failures: unknown[] = []
  const server = createServer((request, response) => {
    void Promise.resolve(adapter.handle(request, response)).catch((error: unknown) => { failures.push(error); response.destroy() })
  })
  onTestFinished(async () => {
    const closing = adapter.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await closing
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no TCP address')
  const base = `http://127.0.0.1:${String(address.port)}`
  const rpc = { stream: (_channel: string, endpoint: string, payload: unknown, signal: AbortSignal) =>
    readRpcStream(fetch, new URL(`${base}/api/_stream/${endpoint}`),
      { type: 'client-request', rpcId: 'stream-fixture', method: endpoint, payload } as { rpcId: string }, signal) }
  return { rpc, adapter, failures, base }
}

it('delivers Unicode values and a clean end over a real socket', async () => {
  const seen: string[] = []
  const f = await fixture(async function* (endpoint, payload) {
    seen.push(endpoint)
    expect(payload).toEqual({ args: { sessionId: 'root' } })
    yield { ok: true, value: '终端\noutput' }
    yield { ok: true, value: { sequence: 2 } }
  })
  const values = await collect(f.rpc.stream('/api', 'terminal/follow', { args: { sessionId: 'root' } }, new AbortController().signal))
  expect(values).toEqual([{ ok: true, value: '终端\noutput' }, { ok: true, value: { sequence: 2 } }])
  expect(seen).toEqual(['terminal/follow'])
  expect(f.failures).toEqual([])
})

it('ends at a business refusal and drains the producer without reading another item', async () => {
  let drained = false, after = false
  const f = await fixture(async function* () {
    try { yield { ok: false, error: { code: 'forbidden', message: 'private terminal', details: {} } }; after = true }
    finally { drained = true }
  })
  expect(await collect(f.rpc.stream('/api', 'terminal/retain', {}, new AbortController().signal))).toEqual([
    { ok: false, error: { code: 'forbidden', message: 'private terminal', details: {} } },
  ])
  expect(drained).toBe(true)
  expect(after).toBe(false)
})

it('aborts and drains a parked producer when the consumer closes', async () => {
  const drained = Promise.withResolvers<undefined>()
  const f = await fixture(async function* (_endpoint, _payload, signal) {
    try {
      yield { ok: true, value: 'attached' }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    } finally { drained.resolve(undefined) }
  })
  for await (const result of f.rpc.stream('/api', 'terminal/follow', {}, new AbortController().signal)) {
    expect(result).toEqual({ ok: true, value: 'attached' })
    break
  }
  await drained.promise
})

it('rejects bad envelopes before dispatch and refuses new streams after disposal', async () => {
  let called = false
  const f = await fixture(async function* () { called = true; yield { ok: true, value: 1 } })
  const post = (body: string, headers = { 'content-type': 'application/json' }) => fetch(`${f.base}/api/_stream/terminal/follow`, { method: 'POST', headers, body })
  expect((await fetch(`${f.base}/api/_stream/terminal/follow`)).status).toBe(404)
  expect((await post('{}', { 'content-type': 'text/plain' })).status).toBe(415)
  expect((await post('{')).status).toBe(400)
  expect((await post('{}')).status).toBe(400)
  expect((await post(JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'wrong/path', payload: {} }))).status).toBe(400)
  expect(called).toBe(false)
  await f.adapter.close()
  expect((await post(JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'terminal/follow', payload: {} }))).status).toBe(503)
})

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}

it('rejects oversized produced frames and drains the source instead of publishing a partial value', async () => {
  let drained = false
  const f = await fixture(async function* () {
    try { yield { ok: true, value: 'x'.repeat(16 * 1024 * 1024) } }
    finally { drained = true }
  })
  await expect(collect(f.rpc.stream('/api', 'terminal/follow', {}, new AbortController().signal))).rejects.toThrow()
  expect(drained).toBe(true)
  expect(f.failures).toHaveLength(1)
  expect(String(f.failures[0])).toContain('byte limit')
})
