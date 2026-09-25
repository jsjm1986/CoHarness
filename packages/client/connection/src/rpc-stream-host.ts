/** Streaming RPC framing on Connection's existing trusted HTTP subtree. */
import { clientRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import { bridge } from './http-bridge.ts'
import type { ConnectionHttpHandler } from './rpc-host.ts'
import type { ConnectionRpcResult } from './rpc.ts'
import { RPC_STREAM_FRAME_MAX_BYTES, RPC_STREAM_PATH } from './rpc-stream.ts'

/** A logical read stream; the owner validates domain arguments and yielded values. */
export type ConnectionRpcStreamHandler = (
  endpoint: string, payload: unknown, signal: AbortSignal,
) => AsyncIterable<ConnectionRpcResult<unknown>>

/**
 * Own bounded response framing, backpressure, cancellation and iterator teardown.
 * @param handler - authorized domain dispatcher producing result frames.
 * @returns an HTTP handler and an awaited shutdown for every open stream.
 */
export function createRpcStreamHttpHandler(handler: ConnectionRpcStreamHandler): { handle: ConnectionHttpHandler; close(): Promise<void> } {
  const lifetime = new AbortController()
  const pending = new Set<Promise<void>>()
  return {
    async handle(request, response) {
      const work = bridge(request, response, { async fetch(request) {
        const path = new URL(request.url).pathname
        const endpoint = path.slice(RPC_STREAM_PATH.length + 1)
        if (request.method !== 'POST' || !path.startsWith(`${RPC_STREAM_PATH}/`) || !/^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/u.test(endpoint)) {
          return new Response('not found', { status: 404 })
        }
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return new Response('unsupported media type', { status: 415 })
        let body: unknown
        try { body = await request.json() } catch { return new Response('invalid request JSON', { status: 400 }) }
        const parsed = clientRequestSchema.safeParse(body)
        if (!parsed.success || parsed.data.method !== endpoint) return new Response('invalid RPC envelope', { status: 400 })
        if (lifetime.signal.aborted) return new Response('stream service stopped', { status: 503 })
        const message = parsed.data, controller = new AbortController()
        const signal = AbortSignal.any([request.signal, lifetime.signal, controller.signal])
        const iterator = handler(endpoint, message.payload, signal)[Symbol.asyncIterator]()
        const encoder = new TextEncoder()
        const finish = async () => { controller.abort(); await iterator.return?.() }
        const stream = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              signal.throwIfAborted()
              const item = await iterator.next()
              signal.throwIfAborted()
              const frame = item.done ? { rpcId: message.rpcId, type: 'end' } : { rpcId: message.rpcId, type: 'result', result: item.value }
              const bytes = encoder.encode(JSON.stringify(frame))
              if (bytes.length > RPC_STREAM_FRAME_MAX_BYTES) throw new Error('RPC stream frame exceeds its byte limit')
              const line = new Uint8Array(bytes.length + 1); line.set(bytes); line[bytes.length] = 10
              output.enqueue(line)
              if (item.done || !item.value.ok) { await finish(); output.close() }
            } catch (error) { await finish(); output.error(error) }
          },
          cancel: finish,
        })
        return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
      } }, RPC_STREAM_FRAME_MAX_BYTES)
      pending.add(work)
      try { await work } finally { pending.delete(work) }
    },
    async close() { lifetime.abort(); await Promise.allSettled([...pending]) },
  }
}
