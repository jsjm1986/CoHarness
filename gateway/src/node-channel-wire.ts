/** WebSocket encoding and bounded buffering shared by the center and outbound node. */
import WebSocket, { type RawData } from 'ws'
import type { z } from 'zod'
import { NodeChannelError, type NodeChannelWireLimits } from './node-channel-protocol.ts'

/**
 * Parse one uncompressed text message after the WebSocket receiver's byte limit.
 * @param data - complete message owned by ws; fragments are bounded before concatenation.
 * @param binary - whether the peer sent a binary message.
 * @param schema - receiving endpoint's strict command or response schema.
 * @returns the validated protocol message.
 */
export function parseNodeChannelFrame<T>(data: RawData, binary: boolean, schema: z.ZodType<T>): T {
  if (binary) throw new NodeChannelError(400, 'node-channel/invalid-frame')
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
  try { return schema.parse(JSON.parse(bytes.toString('utf8'))) }
  catch (cause) { throw new NodeChannelError(400, 'node-channel/invalid-frame', cause) }
}

/**
 * Send one frame only while its serialized bytes and socket buffer fit deployment limits.
 * @param socket - endpoint-owned socket; closed connections are refused.
 * @param value - already typed protocol message.
 * @param limits - validated message and total outbound-buffer budgets.
 * @returns after ws accepts the bounded frame; peer delivery remains unconfirmed.
 */
export function sendNodeChannelFrame(socket: WebSocket, value: unknown, limits: NodeChannelWireLimits): void {
  if (socket.readyState !== WebSocket.OPEN) throw new NodeChannelError(503, 'node-channel/disconnected')
  const frame = JSON.stringify(value), bytes = Buffer.byteLength(frame)
  if (bytes > limits.maxFrameBytes) throw new NodeChannelError(413, 'node-channel/invalid-frame')
  if (socket.bufferedAmount + bytes > limits.maxBufferedBytes) throw new NodeChannelError(503, 'node-channel/slow-peer')
  socket.send(frame)
}
