import type { ConnectionHttpHandler } from './rpc-host.ts'
import type { ConnectionRpcResult } from './rpc.ts'
/** A logical read stream; the owner validates domain arguments and yielded values. */
export type ConnectionRpcStreamHandler =
  (endpoint: string, payload: unknown, signal: AbortSignal) => AsyncIterable<ConnectionRpcResult<unknown>>
/**
 * Own bounded response framing, backpressure, cancellation and iterator teardown.
 * @param handler - authorized domain dispatcher producing result frames.
 * @returns an HTTP handler and an awaited shutdown for every open stream.
 */
export declare function createRpcStreamHttpHandler(handler: ConnectionRpcStreamHandler): {
  handle: ConnectionHttpHandler
  close(): Promise<void>
}
//# sourceMappingURL=rpc-stream-host.d.ts.map
