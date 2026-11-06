/** Backpressured outbound connections to an enrolled computer's existing local Gateway. */
import { connect, type Socket } from 'node:net'
import { Duplex, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import WebSocket, { createWebSocketStream } from 'ws'
import { z } from 'zod'
import { nodeUuidSchema, type NodeCredential, type NodeLease } from './node-access.ts'
import type { NodeDialer } from './node-dialer.ts'
import { NODE_CONNECTION_HEADER, NODE_EPOCH_HEADER, NodeChannelError, type NodeProbeId } from './node-channel-protocol.ts'
import { readResponseJson } from './response-budget.ts'

/** Dedicated binary transport, separate from bounded control JSON messages. */
export const NODE_SERVICE_STREAM_PATH = '/internal/nodes/streams/'
/** WebSocket subprotocol for one HTTP connection, including a possible browser upgrade. */
export const NODE_SERVICE_STREAM_PROTOCOL = 'dsh-node-service-v1'
/** Private local attestation route; the node's live credential and exact lease are required. */
export const NODE_SERVICE_IDENTITY_PATH = '/internal/nodes/service'
/** Request fence checked by a Gateway before processing a forwarded operation. */
export const NODE_SERVICE_TARGET_HEADER = 'x-dsh-target-node'
/** Maximum binary message size; arbitrary source chunks are split before transmission. */
export const NODE_SERVICE_FRAME_BYTES = 65_536

/** Expected forwarding refusal; peer diagnostics and credentials are excluded. */
export class NodeServiceError extends Error {
  /**
   * @param status - public HTTP refusal status.
   * @param code - stable service-admission failure.
   * @param cause - internal diagnostic evidence excluded from public responses.
   */
  constructor(readonly status: 400 | 403 | 404 | 409 | 503 | 504,
    readonly code: 'node-service/unavailable' | 'node-service/mismatch' | 'node-service/busy'
      | 'node-service/cancelled' | 'node-service/timeout' | 'node-service/closed' | 'node-service/invalid-target', cause?: unknown) {
    super(code, { cause }); this.name = 'NodeServiceError'
  }
}

/** Identity reported by the existing Gateway on the enrolled computer. */
export const nodeServiceIdentitySchema = z.object({
  protocolVersion: z.literal(1), organizationId: nodeUuidSchema, nodeId: nodeUuidSchema,
  release: z.string().min(1).max(256).nullable(),
}).strict()

/** Local service connection configuration, resolved independently of browser input. */
export interface NodeServiceBridgeConfig {
  localUrl: string
  /** Ordered center dial candidates shared with the channel and control requests. */
  dialer: NodeDialer
  credential: NodeCredential
  lease: NodeLease
  requestTimeoutMs: number
  /** An explicit release requirement prevents incompatible node services from receiving requests. */
  release: string | null
}

/**
 * Accept only a fixed loopback HTTP origin for the existing node-local Gateway.
 * @param value - operator-configured origin; no browser or center request may choose it.
 * @returns the normalized local origin.
 */
export function nodeServiceLocalOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('HGW_NODE_LOCAL_GATEWAY_URL must be a loopback HTTP origin') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('HGW_NODE_LOCAL_GATEWAY_URL must be a loopback HTTP origin')
  }
  return url.origin
}

/**
 * Wrap one ws connection with Node stream backpressure and bounded binary messages.
 * @param socket - authenticated, endpoint-owned WebSocket.
 * @returns a duplex stream; destroying it closes the underlying connection and framing pipeline.
 */
export function nodeServiceDuplex(socket: WebSocket): Duplex {
  const wire = createWebSocketStream(socket, { highWaterMark: NODE_SERVICE_FRAME_BYTES, allowHalfOpen: false })
  const chunks = new Transform({
    highWaterMark: NODE_SERVICE_FRAME_BYTES,
    transform(chunk: Buffer, _encoding, done) {
      for (let offset = 0; offset < chunk.length; offset += NODE_SERVICE_FRAME_BYTES) {
        this.push(chunk.subarray(offset, offset + NODE_SERVICE_FRAME_BYTES))
      }
      done()
    },
  })
  const stream = Duplex.from({ readable: wire, writable: chunks })
  void pipeline(chunks, wire).catch((error: unknown) => { stream.destroy(error instanceof Error ? error : new Error('Node service stream interrupted')) })
  stream.once('close', () => { chunks.destroy(); wire.destroy() })
  return stream
}

async function localSocket(url: URL, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted()
  // A local response EOF must leave the reverse pipeline alive until its WebSocket output drains.
  const socket = connect({ host: url.hostname === '[::1]' ? '::1' : url.hostname, port: Number(url.port || '80'), allowHalfOpen: true })
  socket.pause()
  return new Promise<Socket>((resolve, reject) => {
    const abort = () => { cleanup(); socket.destroy(); reject(signal.reason) }
    const failed = (error: Error) => { cleanup(); socket.destroy(); reject(error) }
    const cleanup = () => { signal.removeEventListener('abort', abort); socket.removeListener('error', failed) }
    signal.addEventListener('abort', abort, { once: true })
    socket.once('error', failed)
    socket.once('connect', () => { cleanup(); resolve(socket) })
  })
}

/**
 * Bridge one authenticated center connection to the existing Gateway on this computer.
 * @param config - fixed local origin, enrolled identity and transport settings.
 * @param id - one-use center connection identity.
 * @param signal - owning channel/request cancellation; completion includes both socket closures.
 * @returns after the connection and all stream pipelines settle; it never retries a request.
 */
export async function runNodeServiceBridge(config: NodeServiceBridgeConfig, id: NodeProbeId, signal: AbortSignal): Promise<void> {
  const local = new URL(nodeServiceLocalOrigin(config.localUrl))
  const headers = { authorization: `Bearer ${config.credential}`, [NODE_CONNECTION_HEADER]: config.lease.connectionId, [NODE_EPOCH_HEADER]: config.lease.epoch }
  const handshake = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
  const response = await fetch(new URL(NODE_SERVICE_IDENTITY_PATH, local), { headers, signal: handshake, redirect: 'manual' })
  if (!response.ok) { await response.body?.cancel(); throw new NodeServiceError(503, 'node-service/unavailable') }
  const identity = nodeServiceIdentitySchema.parse(await readResponseJson(response, 4096))
  if (identity.nodeId !== config.lease.nodeId || identity.organizationId !== config.lease.organizationId
    || config.release !== null && identity.release !== config.release) {
    throw new NodeServiceError(409, 'node-service/mismatch')
  }
  const gateway = await localSocket(local, handshake)
  // Hold an error listener through WebSocket acquisition, before pipeline owns the TCP stream.
  let earlyError: Error | undefined
  const observe = (error: Error) => { earlyError = error }
  gateway.on('error', observe)
  const origin = config.dialer.current()
  const url = new URL(`${NODE_SERVICE_STREAM_PATH}${id}`, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url, NODE_SERVICE_STREAM_PROTOCOL, { headers, followRedirects: false,
    perMessageDeflate: false, maxPayload: NODE_SERVICE_FRAME_BYTES, handshakeTimeout: config.requestTimeoutMs })
  // Failover tracks only attempts that got no HTTP response; a refused upgrade
  // reached a center, so it is a stream failure like before, not a dial change.
  let opened = false, responded = false
  socket.once('open', () => { opened = true })
  socket.once('unexpected-response', () => { responded = true; socket.terminate() })
  const wire = nodeServiceDuplex(socket)
  const observeWire = (error: Error) => { earlyError = error; gateway.destroy() }
  wire.on('error', observeWire)
  const closed = new Promise<void>(resolve => { socket.once('close', () => { resolve() }) })
  const gatewayClosed = new Promise<void>(resolve => { gateway.once('close', () => { resolve() }) })
  const abort = () => { wire.destroy(); gateway.destroy(); socket.terminate() }
  signal.addEventListener('abort', abort, { once: true })
  const interrupted = () => { if (!gateway.readableEnded) wire.destroy() }
  gateway.once('close', interrupted)
  try {
    if (signal.aborted) abort()
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) { resolve(); return }
      const fail = (error: Error) => { cleanup(); reject(error) }
      const ended = () => { cleanup(); reject(new NodeChannelError(503, 'node-channel/disconnected')) }
      const opened = () => { cleanup(); resolve() }
      const cleanup = () => { socket.removeListener('error', fail); socket.removeListener('close', ended); socket.removeListener('open', opened) }
      socket.once('error', fail); socket.once('close', ended); socket.once('open', opened)
    })
    if (earlyError !== undefined) throw earlyError
    await Promise.all([pipeline(gateway, wire), pipeline(wire, gateway)])
  } catch (error) {
    if (!signal.aborted && !opened && !responded) config.dialer.failed(origin, error)
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    abort()
    await Promise.all([closed, gatewayClosed])
    gateway.removeListener('error', observe)
    wire.removeListener('error', observeWire)
  }
}
