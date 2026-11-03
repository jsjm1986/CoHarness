/** Bounded control messages for an outbound node connection; no message authorizes runtime execution. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { nodeLeaseSchema, nodeUuidSchema, type NodeLease } from './node-access.ts'

/** WebSocket endpoint owned by the center's node-control service. */
export const NODE_CHANNEL_PATH = '/internal/nodes/channel'
/** Negotiated control protocol; browser/runtime WebSockets use separate authentication. */
export const NODE_CHANNEL_PROTOCOL = 'dsh-node-control-v1'
/** Header carrying the agent process's existing connection identity. */
export const NODE_CONNECTION_HEADER = 'x-dsh-node-connection'
/** Header carrying the exact PostgreSQL lease epoch. */
export const NODE_EPOCH_HEADER = 'x-dsh-node-epoch'
/** Correlation identity for one control request, never a durable mutation receipt. */
export type NodeProbeId = Branded<'NodeProbeId'>

/** Frame and outbound-buffer limits applied independently at each endpoint. */
export interface NodeChannelWireLimits {
  maxFrameBytes: number
  maxBufferedBytes: number
}

/** Center admission limits; requests above capacity are refused without queuing. */
export interface NodeChannelConfig extends NodeChannelWireLimits {
  maxConnections: number
  maxInFlight: number
  maxPerNode: number
  requestTimeoutMs: number
}

/** Node-side bound on concurrent read-only control handlers. */
export interface NodeChannelClientLimits extends NodeChannelWireLimits {
  maxInFlight: number
}

/** Safe node observation; paths, hostname, environment variables and files are excluded. */
export const nodeProbeInfoSchema = z.object({
  platform: z.enum(['darwin', 'linux']), architecture: z.enum(['x64', 'arm64']),
  uptimeSeconds: z.number().int().nonnegative().safe(), executionReady: z.literal(false),
}).strict()
/** Read-only observation returned by a connected node. */
export type NodeProbeInfo = z.infer<typeof nodeProbeInfoSchema>

/** Confirmed observation bound to the node connection and epoch that actually replied. */
export interface NodeProbeResult {
  nodeId: NodeLease['nodeId']
  connectionId: NodeLease['connectionId']
  epoch: NodeLease['epoch']
  info: NodeProbeInfo
}

const probeId = nodeUuidSchema.transform(value => value as NodeProbeId)
/** Initial center identity, checked before the node accepts control requests. */
export const nodeChannelReadySchema = nodeLeaseSchema.extend({ kind: z.literal('ready'), channelVersion: z.literal(1) }).strict()
/** Center-to-node messages accepted by the control-only agent. */
export const nodeChannelCommandSchema = z.discriminatedUnion('kind', [
  nodeChannelReadySchema,
  z.object({ kind: z.literal('probe'), id: probeId }).strict(),
  z.object({ kind: z.literal('service'), id: probeId, release: z.string().min(1).max(256).nullable() }).strict(),
  z.object({ kind: z.literal('cancel'), id: probeId }).strict(),
])
/** Node-to-center replies; a failed observation changes no runtime or durable node state. */
export const nodeChannelReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('result'), id: probeId, info: nodeProbeInfoSchema }).strict(),
  z.object({ kind: z.literal('failure'), id: probeId, error: z.enum(['busy', 'probe-failed', 'service-unavailable', 'service-failed']) }).strict(),
])
/** Parsed node control request. */
export type NodeChannelCommand = z.infer<typeof nodeChannelCommandSchema>
/** Parsed node control response. */
export type NodeChannelReply = z.infer<typeof nodeChannelReplySchema>

/** Stable control failures; every operation in this protocol is safe to abandon without changing a runtime. */
export type NodeChannelErrorCode = 'node-channel/unavailable' | 'node-channel/not-connected' | 'node-channel/busy'
  | 'node-channel/timeout' | 'node-channel/cancelled' | 'node-channel/disconnected' | 'node-channel/invalid-frame'
  | 'node-channel/slow-peer' | 'node-channel/closed' | 'node-channel/probe-failed'

/** Control failure retaining its public status and safe diagnostic, without peer payloads or credentials. */
export class NodeChannelError extends Error {
  /**
   * @param status - HTTP diagnostic status for the administrator.
   * @param code - declared transport or observation failure.
   * @param cause - internal evidence, excluded from public diagnostics.
   */
  constructor(readonly status: 400 | 409 | 413 | 503 | 504, readonly code: NodeChannelErrorCode, cause?: unknown) {
    super(code, { cause }); this.name = 'NodeChannelError'
  }
}

function setting(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum = 1, maximum = 2_147_483_647): number {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function wireLimits(env: NodeJS.ProcessEnv, prefix: string): NodeChannelWireLimits {
  const maxFrameBytes = setting(env, `${prefix}_MAX_FRAME_BYTES`, 16_384, 1024, 65_536)
  const maxBufferedBytes = setting(env, `${prefix}_MAX_BUFFERED_BYTES`, 65_536)
  if (maxBufferedBytes < maxFrameBytes) throw new Error(`${prefix}_MAX_BUFFERED_BYTES must cover one complete frame`)
  return { maxFrameBytes, maxBufferedBytes }
}

/**
 * Resolve center control-channel limits before listener acquisition.
 * @param env - deployment environment; absent settings use explicit defaults.
 * @returns validated connection, concurrency, timeout and byte budgets.
 */
export function loadNodeChannelConfig(env: NodeJS.ProcessEnv): NodeChannelConfig {
  const maxInFlight = setting(env, 'HGW_NODE_CHANNEL_MAX_INFLIGHT', 64)
  const maxPerNode = setting(env, 'HGW_NODE_CHANNEL_MAX_PER_NODE', 4)
  if (maxPerNode > maxInFlight) throw new Error('HGW_NODE_CHANNEL_MAX_PER_NODE must not exceed HGW_NODE_CHANNEL_MAX_INFLIGHT')
  return { ...wireLimits(env, 'HGW_NODE_CHANNEL'), maxInFlight, maxPerNode,
    maxConnections: setting(env, 'HGW_NODE_CHANNEL_MAX_CONNECTIONS', 64),
    requestTimeoutMs: setting(env, 'HGW_NODE_CHANNEL_REQUEST_TIMEOUT_MS', 10_000) }
}

/**
 * Resolve the optional node control client before credential or network acquisition.
 * @param env - agent environment; the channel is enabled unless explicitly set to 0.
 * @returns validated budgets, or null when HGW_NODE_AGENT_CHANNEL_ENABLED is 0.
 */
export function loadNodeChannelClientLimits(env: NodeJS.ProcessEnv): NodeChannelClientLimits | null {
  const enabled = env.HGW_NODE_AGENT_CHANNEL_ENABLED
  if (enabled !== undefined && enabled !== '0' && enabled !== '1') throw new Error('HGW_NODE_AGENT_CHANNEL_ENABLED must be 0 or 1')
  if (enabled === '0') return null
  return { ...wireLimits(env, 'HGW_NODE_AGENT_CHANNEL'), maxInFlight: setting(env, 'HGW_NODE_AGENT_CHANNEL_MAX_INFLIGHT', 4) }
}
