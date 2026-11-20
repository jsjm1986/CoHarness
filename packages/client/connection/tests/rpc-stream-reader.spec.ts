/** Wire refusals and byte limits cannot be normalized into successful completion. */
import { expect, it, vi } from 'vitest'
import { readRpcStream } from '../src/rpc-stream-reader.ts'
import { ConnectionRpcStreamInterrupted, RPC_STREAM_FRAME_MAX_BYTES } from '../src/rpc-stream.ts'

const url = new URL('http://localhost/api/_stream/terminal/follow')
const message = { rpcId: 'read' }
const signal = () => new AbortController().signal
const result = (value: unknown) => ({ rpcId: 'read', type: 'result', result: { ok: true, value } })
const end = { rpcId: 'read', type: 'end' }
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}
function response(bytes: Uint8Array[], cancel?: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of bytes) controller.enqueue(chunk) },
    ...(cancel === undefined ? {} : { cancel }),
  }), { headers: { 'content-type': 'application/x-ndjson' } })
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n')

it('joins split UTF-8 and frame chunks without losing characters or order', async () => {
  const bytes = encode(result('中文'))
  const point = bytes.findIndex(value => value > 127) + 1
  const send = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(
    async () => response([bytes.slice(0, point), bytes.slice(point), encode(end)]))
  expect(await collect(readRpcStream(send, url, message, signal()))).toEqual([{ ok: true, value: '中文' }])
  expect(JSON.parse(send.mock.calls[0]![1].body as string)).toEqual(message)
})

it.each([null, [], { rpcId: 'wrong', type: 'end' }, { ...end, extra: 1 }, { rpcId: 'read', type: 'other' }, { rpcId: 'read', type: 'result', result: {} }])('rejects invalid or mismatched frames: %j', async (value) => {
  await expect(collect(readRpcStream(async () => response([encode(value)]), url, message, signal()))).rejects.toThrow()
})

it('bounds unfinished lines before JSON decoding', async () => {
  await expect(collect(readRpcStream(async () => response([new Uint8Array(RPC_STREAM_FRAME_MAX_BYTES + 1)]), url, message, signal())))
    .rejects.toThrow('byte limit')
})

it.each([new Response(null, { status: 403 }), new Response('bad'), new Response(null, { headers: { 'content-type': 'application/x-ndjson' } })])('rejects refused or nonstreaming responses', async (value) => {
  await expect(collect(readRpcStream(async () => value, url, message, signal()))).rejects.toThrow('refused')
})

it('distinguishes physical connection loss and truncated completion from domain refusal', async () => {
  await expect(collect(readRpcStream(async () => { throw new Error('offline') }, url, message, signal()))).rejects.toBeInstanceOf(ConnectionRpcStreamInterrupted)
  await expect(collect(readRpcStream(async () => new Response(new ReadableStream({ start(controller) { controller.close() } }),
    { headers: { 'content-type': 'application/x-ndjson' } }), url, message, signal()))).rejects.toThrow('without its completion')
  await expect(collect(readRpcStream(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('lost socket')) } }),
    { headers: { 'content-type': 'application/x-ndjson' } }), url, message, signal()))).rejects.toBeInstanceOf(ConnectionRpcStreamInterrupted)
})

it('preserves cancellation before opening, during connection and while reading', async () => {
  const aborted = AbortSignal.abort(new Error('caller left'))
  const send = vi.fn(async () => response([encode(end)]))
  await expect(collect(readRpcStream(send, url, message, aborted))).rejects.toThrow('caller left')
  expect(send).not.toHaveBeenCalled()
  const connecting = new AbortController()
  await expect(collect(readRpcStream(async () => { connecting.abort(new Error('connect cancelled')); throw new Error('fetch cancelled') }, url, message, connecting.signal)))
    .rejects.toThrow('connect cancelled')
  const reading = new AbortController()
  await expect(collect(readRpcStream(async () => new Response(new ReadableStream({ start(controller) {
    reading.abort(new Error('read cancelled')); controller.error(new Error('read transport'))
  } }), { headers: { 'content-type': 'application/x-ndjson' } }), url, message, reading.signal))).rejects.toThrow('read cancelled')
})

it('surfaces a cleanup failure after an otherwise clean end', async () => {
  await expect(collect(readRpcStream(async () => response([encode(end)], () => { throw new Error('close failed') }), url, message, signal()))).rejects.toThrow('close failed')
})

it('cancels a parked body itself and waits for its cleanup before releasing the reader', async () => {
  const caller = new AbortController()
  const reading = Promise.withResolvers<undefined>()
  const cancelling = Promise.withResolvers<undefined>()
  const cleaned = Promise.withResolvers<undefined>()
  const cancel = vi.fn(() => { cancelling.resolve(undefined); return cleaned.promise })
  const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(undefined) }, cancel }, { highWaterMark: 0 })
  const result = collect(readRpcStream(async () => new Response(body,
    { headers: { 'content-type': 'application/x-ndjson' } }), url, message, caller.signal))
  const settled = result.then(value => ({ value }), (error: unknown) => ({ error }))
  await reading.promise
  const reason = new Error('pane closed')
  caller.abort(reason)
  await cancelling.promise
  expect(body.locked).toBe(true)
  expect(cancel).toHaveBeenCalledTimes(1)
  cleaned.resolve(undefined)
  expect(await settled).toEqual({ error: reason })
  expect(body.locked).toBe(false)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it.each([end, { ...end, rpcId: 'wrong' }])('removes its body-abort listener after completion or decoding failure: %j', async (frame) => {
  const added = vi.spyOn(AbortSignal.prototype, 'addEventListener')
  const removed = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
  const body = response([encode(frame)])
  try {
    const pending = collect(readRpcStream(async () => body, url, message, signal()))
    if (frame.rpcId === message.rpcId) await expect(pending).resolves.toEqual([])
    else await expect(pending).rejects.toThrow('correlation mismatch')
    const listener = added.mock.calls.find(([type]) => type === 'abort')?.[1]
    expect(listener).toBeTypeOf('function')
    expect(removed).toHaveBeenCalledWith('abort', listener)
    expect(body.body?.locked).toBe(false)
  } finally { added.mockRestore(); removed.mockRestore() }
})
