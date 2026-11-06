/** Outbound control client; heartbeat ownership and runtime execution remain separate. */
import { uptime } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import type { NodeCredential, NodeLease } from './node-access.ts'
import type { NodeDialer } from './node-dialer.ts'
import {
  NODE_CHANNEL_PATH, NODE_CHANNEL_PROTOCOL, NODE_CONNECTION_HEADER, NODE_EPOCH_HEADER, NodeChannelError,
  nodeChannelCommandSchema, type NodeChannelClientLimits, type NodeChannelErrorCode, type NodeProbeId, type NodeProbeInfo,
} from './node-channel-protocol.ts'
import { parseNodeChannelFrame, sendNodeChannelFrame } from './node-channel-wire.ts'
import { runNodeServiceBridge } from './node-service-stream.ts'

interface ServiceJob {
  id: NodeProbeId
  release: string | null
  controller: AbortController
}

/** One physical bridge permit; a cancelled owner can reserve one successor until its cleanup completes. */
interface ServiceSlot {
  current: ServiceJob
  successor?: ServiceJob
}

/** Explicit client configuration resolved before acquiring a socket. */
export interface NodeChannelClientConfig {
  /** Ordered center dial candidates; the agent owns one instance per process. */
  dialer: NodeDialer
  credential: NodeCredential
  lease: NodeLease
  limits: NodeChannelClientLimits
  requestTimeoutMs: number
  retryMs: number
  /** Fixed loopback Gateway origin; absent compositions expose read-only probes alone. */
  localGatewayUrl?: string
  /** Maximum running/cleaning bridges; each cancelled owner can reserve one successor without opening another bridge. */
  maxServices?: number
}

/** Safe channel diagnostics; credentials and peer payloads are excluded. */
export type NodeChannelClientEvent = { status: 'channel-ready'; nodeId: NodeLease['nodeId']; epoch: NodeLease['epoch'] }
  | { status: 'channel-degraded'; reason: NodeChannelErrorCode }

/** A read-only provider must settle after cancellation; the client awaits owned work before reconnecting or stopping. */
export type NodeProbeProvider = (signal: AbortSignal) => Promise<NodeProbeInfo>

/**
 * Read bounded platform metadata without enumerating directories or opening a runtime.
 * @param signal - owning request cancellation.
 * @param executionReady - whether a local Gateway was configured to allocate Runtimes.
 * @returns supported host platform, architecture, uptime and execution capability.
 */
export async function localNodeProbe(signal: AbortSignal, executionReady = false): Promise<NodeProbeInfo> {
  signal.throwIfAborted()
  if ((process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32')
    || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new NodeChannelError(503, 'node-channel/probe-failed')
  }
  return { platform: process.platform, architecture: process.arch, uptimeSeconds: Math.floor(uptime()), executionReady }
}

async function connect(config: NodeChannelClientConfig, signal: AbortSignal,
  report: (event: NodeChannelClientEvent) => void, provider: NodeProbeProvider): Promise<void> {
  signal.throwIfAborted()
  const origin = config.dialer.current()
  const url = new URL(NODE_CHANNEL_PATH, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url, NODE_CHANNEL_PROTOCOL, {
    headers: { authorization: `Bearer ${config.credential}`, [NODE_CONNECTION_HEADER]: config.lease.connectionId, [NODE_EPOCH_HEADER]: config.lease.epoch },
    followRedirects: false, perMessageDeflate: false, maxPayload: config.limits.maxFrameBytes, handshakeTimeout: config.requestTimeoutMs,
  })
  const jobs = new Map<NodeProbeId, AbortController>(), services = new Map<NodeProbeId, ServiceJob>()
  const serviceSlots = new Set<ServiceSlot>(), work = new Set<Promise<void>>()
  let ready = false, failure: unknown
  // Failover tracks only attempts that got no HTTP response; a refused upgrade
  // reached a center, so it is a channel failure like before, not a dial change.
  let opened = false, responded = false
  socket.once('open', () => { opened = true })
  socket.once('unexpected-response', (_request, response) => {
    responded = true
    failure = new NodeChannelError(503, 'node-channel/disconnected', new Error(`Unexpected server response: ${String(response.statusCode)}`))
    socket.terminate()
  })
  let pulse: ReturnType<typeof setInterval> | undefined
  const stop = () => { socket.terminate() }
  signal.addEventListener('abort', stop, { once: true })
  const closed = new Promise<void>(resolve => { socket.once('close', () => { resolve() }) })
  const readyTimer = setTimeout(() => { failure = new NodeChannelError(504, 'node-channel/timeout'); stop() }, config.requestTimeoutMs)
  readyTimer.unref()
  const fail = (error: unknown) => { failure = error; stop() }
  socket.on('error', error => { failure = new NodeChannelError(503, 'node-channel/disconnected', error) })
  socket.on('message', (bytes, binary) => {
    if (signal.aborted) return
    try {
      const command = parseNodeChannelFrame(bytes, binary, nodeChannelCommandSchema)
      if (command.kind === 'ready') {
        if (ready || command.nodeId !== config.lease.nodeId || command.organizationId !== config.lease.organizationId
          || command.connectionId !== config.lease.connectionId || command.epoch !== config.lease.epoch) {
          throw new NodeChannelError(400, 'node-channel/invalid-frame')
        }
        ready = true; clearTimeout(readyTimer)
        pulse = setInterval(() => {
          if (signal.aborted || socket.readyState !== WebSocket.OPEN) return
          try { socket.ping() } catch (error) { fail(error) }
        }, config.lease.heartbeatMs)
        pulse.unref()
        report({ status: 'channel-ready', nodeId: command.nodeId, epoch: command.epoch })
        return
      }
      if (!ready) throw new NodeChannelError(400, 'node-channel/invalid-frame')
      if (command.kind === 'cancel') { jobs.get(command.id)?.abort(); services.get(command.id)?.controller.abort(); return }
      if (jobs.has(command.id) || services.has(command.id)) throw new NodeChannelError(400, 'node-channel/invalid-frame')
      if (command.kind === 'service') {
        if (config.localGatewayUrl === undefined || config.maxServices === undefined) {
          sendNodeChannelFrame(socket, { kind: 'failure', id: command.id, error: 'service-unavailable' }, config.limits)
          return
        }
        const job: ServiceJob = { id: command.id, release: command.release, controller: new AbortController() }
        if (serviceSlots.size >= config.maxServices) {
          const retiring = [...serviceSlots].find(slot => slot.current.controller.signal.aborted && slot.successor === undefined)
          if (retiring === undefined) {
            sendNodeChannelFrame(socket, { kind: 'failure', id: command.id, error: 'busy' }, config.limits)
            return
          }
          retiring.successor = job
          services.set(job.id, job)
          return
        }
        const localUrl = config.localGatewayUrl
        const slot: ServiceSlot = { current: job }
        serviceSlots.add(slot)
        services.set(job.id, job)
        const operation = (async () => {
          try {
            for (;;) {
              const current = slot.current
              if (signal.aborted || socket.readyState !== WebSocket.OPEN) current.controller.abort()
              try {
                if (!current.controller.signal.aborted) {
                  await runNodeServiceBridge({ ...config, localUrl, release: current.release }, current.id, current.controller.signal)
                }
              } catch {
                // Bridge failures report their own service request; cancelled owners need no reply.
                if (!current.controller.signal.aborted && socket.readyState === WebSocket.OPEN) {
                  try { sendNodeChannelFrame(socket, { kind: 'failure', id: current.id, error: 'service-failed' }, config.limits) }
                  catch (error) { fail(error) }
                }
              } finally { services.delete(current.id) }
              if (slot.successor === undefined) return
              slot.current = slot.successor
              slot.successor = undefined
            }
          } finally { serviceSlots.delete(slot) }
        })()
        work.add(operation)
        void operation.then(() => { work.delete(operation) }, fail)
        return
      }
      if (jobs.size >= config.limits.maxInFlight) {
        sendNodeChannelFrame(socket, { kind: 'failure', id: command.id, error: 'busy' }, config.limits)
        return
      }
      const controller = new AbortController()
      jobs.set(command.id, controller)
      const operation = (async () => {
        try {
          const info = await provider(controller.signal)
          if (!controller.signal.aborted && socket.readyState === WebSocket.OPEN) {
            sendNodeChannelFrame(socket, { kind: 'result', id: command.id, info }, config.limits)
          }
        } catch (error) {
          if (!controller.signal.aborted && socket.readyState === WebSocket.OPEN) {
            try { sendNodeChannelFrame(socket, { kind: 'failure', id: command.id, error: 'probe-failed' }, config.limits) }
            catch (sendError) { fail(sendError) }
          }
        } finally { jobs.delete(command.id) }
      })()
      work.add(operation)
      void operation.then(() => { work.delete(operation) }, fail)
    } catch (error) { fail(error) }
  })
  try { await closed }
  finally {
    clearTimeout(readyTimer)
    clearInterval(pulse)
    signal.removeEventListener('abort', stop)
    for (const controller of jobs.values()) controller.abort()
    for (const job of services.values()) job.controller.abort()
    await Promise.allSettled([...work])
  }
  if (!signal.aborted) {
    if (!opened && !responded) config.dialer.failed(origin, failure)
    throw failure instanceof NodeChannelError ? failure : new NodeChannelError(503, 'node-channel/disconnected', failure)
  }
}

/**
 * Supervise exactly one outbound socket for an already owned lease, independently of heartbeat requests.
 * @param config - credential, exact lease, explicit endpoint budgets and retry timing.
 * @param signal - lease/process owner cancellation; stopping awaits socket closure and provider quiescence.
 * @param report - safe readiness/degradation diagnostics; repeated identical failures are coalesced.
 * @param provider - read-only observation provider; omitted uses bounded local platform metadata.
 * @returns after cancellation; transport establishment is retried, while forwarded requests are never replayed.
 */
export async function runNodeChannel(config: NodeChannelClientConfig, signal: AbortSignal,
  report: (event: NodeChannelClientEvent) => void,
  provider: NodeProbeProvider = signal => localNodeProbe(signal, config.localGatewayUrl !== undefined)): Promise<void> {
  let degraded: NodeChannelErrorCode | undefined
  while (!signal.aborted) {
    try {
      await connect(config, signal, event => { degraded = undefined; report(event) }, provider)
    } catch (error) {
      if (signal.aborted) break
      const code = error instanceof NodeChannelError ? error.code : 'node-channel/disconnected'
      if (code !== degraded) report({ status: 'channel-degraded', reason: code })
      degraded = code
    }
    if (!signal.aborted) {
      try { await delay(config.retryMs, undefined, { signal }) } catch (error) { if (!signal.aborted) throw error }
    }
  }
}
