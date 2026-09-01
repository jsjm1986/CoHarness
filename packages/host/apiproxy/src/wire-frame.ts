import type { RpcRequest } from './api/rpc.ts'

/**
 * SSE wire encoder shared by api-proxy.ts (FrameQueue push-time accounting)
 * and fetch/handler.ts (stream write loop). A WeakMap keyed by the envelope
 * object caches the serialized string so a large payload is stringified
 * exactly once: push-time accounting populates the cache, the SSE writer
 * consumes it on the way out. This avoids the historical 2× cost on tool
 * results and other multi-MiB frames without changing the public stream
 * shape (AsyncGenerator<RpcRequest<...>> remains the in-process contract).
 */

type QueueFrame = RpcRequest<{ type: string }>

const wireCache = new WeakMap<object, string>()

/** Serialize a narrow RpcRequest into `data: <ServerRequest JSON>\n\n` and
 *  cache it on the envelope for later reuse via {@link peekWireFrame}.
 *  Returns the wire string and its UTF-8 byte length. */
export function encodeWireFrame(item: QueueFrame): { wire: string; bytes: number } {
  const cached = wireCache.get(item)
  if (cached !== undefined) return { wire: cached, bytes: Buffer.byteLength(cached) }
  let payloadStr: string
  try {
    payloadStr = JSON.stringify(item.payload)
  } catch {
    // toJSON throw / circular / BigInt: replace with null rather than
    // killing the producer. Shouldn't happen because assertJsonArgs gates
    // all forwarded events, but belt-and-braces.
    payloadStr = 'null'
  }
  const rpcIdJson = JSON.stringify(item.rpcId)
  const methodJson = JSON.stringify(item.payload.type)
  const full = `{"type":"server-request","rpcId":${rpcIdJson},"method":${methodJson},"payload":${payloadStr}}`
  const wire = `data: ${full}\n\n`
  wireCache.set(item, wire)
  return { wire, bytes: Buffer.byteLength(wire) }
}

/** Return the cached wire string for an envelope produced through FrameQueue,
 *  or encode it on the spot for ad-hoc frames (pre-queue yields, mid-stream
 *  failures). */
export function wireFrameString(item: QueueFrame): string {
  const cached = wireCache.get(item)
  return cached !== undefined ? cached : encodeWireFrame(item).wire
}

/** Remove an item's cache entry after it's been flushed down the wire. */
export function forgetWireFrame(item: object): void {
  wireCache.delete(item)
}
