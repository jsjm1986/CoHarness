/** A single cancellable RPC stream over the existing authenticated HTTP carrier. */
import { serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRpcResult } from './rpc.ts'
import { ConnectionRpcStreamInterrupted, RPC_STREAM_FRAME_MAX_BYTES } from './rpc-stream.ts'
type RpcFetch = (url: URL, init: RequestInit) => Promise<Response>

/**
 * Read complete correlated frames; truncation is distinct from a clean end or business refusal.
 * @param send - the owning Connection's fetch transport.
 * @param url - target-scoped stream URL.
 * @param message - ordinary request envelope with its correlation identity.
 * @param signal - caller lifetime, including provider and pane disposal.
 * @returns result frames; reader cancellation is awaited on early return.
 */
export async function* readRpcStream(
  send: RpcFetch, url: URL, message: { rpcId: string }, signal: AbortSignal,
): AsyncGenerator<ConnectionRpcResult<unknown>> {
  const lifetime = new AbortController(), abort = AbortSignal.any([signal, lifetime.signal])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let failed = false
  try {
    abort.throwIfAborted()
    let response: Response
    try {
      response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message), signal: abort })
    } catch (cause) {
      abort.throwIfAborted()
      throw new ConnectionRpcStreamInterrupted('RPC stream connection failed', { cause })
    }
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/x-ndjson' || response.body === null) {
      await response.body?.cancel()
      throw new Error(`RPC stream refused (${String(response.status)})`)
    }
    reader = response.body.getReader()
    let parts: Uint8Array[] = [], size = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() } catch (cause) {
        abort.throwIfAborted()
        throw new ConnectionRpcStreamInterrupted('RPC stream connection lost', { cause })
      }
      abort.throwIfAborted()
      if (chunk.done) throw new ConnectionRpcStreamInterrupted('RPC stream ended without its completion frame')
      let start = 0
      for (let index = 0; index <= chunk.value.length; index++) {
        if (index < chunk.value.length && chunk.value[index] !== 10) continue
        const part = chunk.value.subarray(start, index)
        size += part.length
        if (size > RPC_STREAM_FRAME_MAX_BYTES) throw new Error('RPC stream frame exceeds its byte limit')
        parts.push(part)
        start = index + 1
        if (index === chunk.value.length) break
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const piece of parts) { bytes.set(piece, offset); offset += piece.length }
        const value: unknown = JSON.parse(decoder.decode(bytes))
        parts = []; size = 0
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid RPC stream frame')
        const frame = value as Record<string, unknown>
        if (frame.rpcId !== message.rpcId) throw new Error('RPC stream correlation mismatch')
        if (frame.type === 'end' && Object.keys(frame).length === 2) return
        if (frame.type !== 'result' || Object.keys(frame).length !== 3) throw new Error('Invalid RPC stream frame')
        const envelope = serverResponseSchema.parse({ type: 'server-response', rpcId: frame.rpcId, result: frame.result })
        yield envelope.result
        if (!envelope.result.ok) return
      }
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    const cancelled = reader?.cancel()
    lifetime.abort()
    try { await cancelled } catch (error) {
      // An errored reader rejects cancellation with the read failure already delivered above.
      if (!failed) throw error
    } finally { reader?.releaseLock() }
  }
}
