/** Correlated, bounded frames for a logical RPC stream. */
import type { ConnectionRpcResult } from './rpc.ts'

/** Maximum UTF-8 bytes in one complete wire frame, excluding its newline. */
export const RPC_STREAM_FRAME_MAX_BYTES = 16 * 1024 * 1024
/** Streaming requests share the authenticated Connection HTTP subtree. */
export const RPC_STREAM_PATH = '/api/_stream'
/** One value or failure, followed by an explicit clean end. */
export type ConnectionRpcStreamFrame =
  | { readonly rpcId: string; readonly type: 'result'; readonly result: ConnectionRpcResult<unknown> }
  | { readonly rpcId: string; readonly type: 'end' }

/** A lost physical stream; a domain supervisor decides whether reading can resume. */
export class ConnectionRpcStreamInterrupted extends Error {}
