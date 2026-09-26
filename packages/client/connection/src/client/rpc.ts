/** Browser caller for generic Connection unary RPC channels. */

import {
  RpcId,
  serverResponseSchema,
  type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { readApiResponseJson } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { ClientConnectionRpc } from '../rpc.ts'
import type { ConnectionRuntimeTarget } from './api.ts'
import { readRpcStream } from '../rpc-stream-reader.ts'
import { RPC_STREAM_PATH } from '../rpc-stream.ts'
import { randomUuid } from './random-uuid.ts'

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Transport this caller posts through; same signature as the global `fetch`. */
export type RpcFetch = (input: URL, init: RequestInit) => Promise<Response>

/**
 * Create the browser-backed generic RPC caller.
 * @param doFetch - transport override; defaults to the page's global fetch.
 * @param target - optional authenticated Gateway runtime target.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createWebConnectionRpc(doFetch?: RpcFetch, target?: ConnectionRuntimeTarget): ClientConnectionRpc {
  const send: RpcFetch = doFetch ?? ((input, init) => globalThis.fetch(input, init))
  return {
    stream(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      if (channel !== '/api') throw new Error('Streaming RPC requires the shared /api channel')
      const message: ClientRequest = { type: 'client-request', rpcId: RpcId(randomUuid()), method: endpoint, payload }
      const url = new URL(`${RPC_STREAM_PATH}/${endpoint}`, resolveBase())
      if (target !== undefined) url.searchParams.set('dshTarget', target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`)
      return readRpcStream(send, url, message, signal)
    },
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      const url = new URL(`${channel}/${endpoint}`, resolveBase())
      if (target !== undefined) url.searchParams.set('dshTarget', target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`)
      const response = await send(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          ...signal === undefined ? {} : { signal },
        },
      )
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const full = serverResponseSchema.parse(await readApiResponseJson(response))
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

function resolveBase(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
