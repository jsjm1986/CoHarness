/** Outbound node registration and local Gateway bridge; this process needs no database credential or inbound listener. */
import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import {
  NODE_ACCESS_ERROR_CODES, nodeCredentialSchema, nodeEnrollmentTokenSchema, nodeIdentitySchema, nodeLeaseSchema,
  type NodeCredential, type NodeEnrollmentToken, type NodeIdentity, type NodeLease,
} from './node-access.ts'
import { readResponseJson, ResponseBodyTooLargeError } from './response-budget.ts'
import { NodeDialer, type NodeDialReason } from './node-dialer.ts'
import { runNodeChannel, type NodeChannelClientEvent } from './node-channel-client.ts'
import { loadNodeChannelClientLimits, type NodeChannelClientLimits } from './node-channel-protocol.ts'
import { nodeServiceLocalOrigin } from './node-service-stream.ts'
import { privateFileState, syncStateDirectory, tightenPrivateFileAcl } from './node-private-file.ts'

/** Explicit node-process configuration; credentials are persisted separately from deployment settings. */
export interface NodeAgentConfig {
  /** Local Gateway identity fixed by the operator; enrollment cannot change the computer or organization. */
  expectedIdentity?: Pick<NodeIdentity, 'organizationId' | 'nodeId'>
  centerUrl: string
  /** Ordered origins dialed to reach the center; defaults to `[centerUrl]`. Identity stays `centerUrl`. */
  centerDialUrls: readonly string[]
  /** After a dial fallback, the first fresh attempt at least this long later re-probes candidate 0. */
  dialPreferredRetryMs: number
  stateFile: string
  enrollmentToken?: NodeEnrollmentToken
  requestTimeoutMs: number
  retryMs: number
  /** Present enables a supervised outbound control socket; absent keeps heartbeat-only embedding. */
  channel?: NodeChannelClientLimits
  /** Existing node-local Gateway; absence exposes control observations alone. */
  localGatewayUrl?: string
  /** Explicit service-connection budget resolved before socket acquisition. */
  maxServices?: number
}

/** Local failures and authenticated center refusals exposed by the node process. */
export type NodeAgentErrorCode = typeof NODE_ACCESS_ERROR_CODES[number]
  | 'node-agent/invalid-timing' | 'node-agent/center-url-required' | 'node-agent/invalid-center-url'
  | 'node-agent/invalid-enrollment-token' | 'node-agent/invalid-dial-urls' | 'node-agent/state-unreadable' | 'node-agent/state-must-be-private'
  | 'node-agent/invalid-state' | 'node-agent/center-identity-mismatch' | 'node-agent/pending-enrollment-mismatch'
  | 'node-agent/enrollment-required' | 'node-agent/transport-unavailable' | 'node-agent/invalid-response'
  | 'node-agent/center-refused' | 'node-agent/unsupported-platform' | 'node-agent/unsupported-architecture'
  | 'node-agent/state-changed'
  | 'node-agent/invalid-channel-config' | 'node-agent/channel-failed'

const FAILURE_MESSAGES: Record<NodeAgentErrorCode, string> = {
  'node-access/invalid-request': 'The center refused a control message. Check that the agent and center releases are compatible.',
  'node-access/unauthorized': 'The center refused this credential. Ask an administrator to check or reissue node access.',
  'node-access/forbidden': 'The center refused access. Ask an administrator to check the organization and node.',
  'node-access/not-found': 'The center no longer has this node. Ask an administrator to check node access.',
  'node-access/name-conflict': 'This node name is already registered. Choose another name in Admin.',
  'node-access/enrollment-already-issued': 'This issuance request was already committed. Check the Admin directory before issuing another ticket.',
  'node-access/revision-conflict': 'Node access changed. Refresh its Admin entry before retrying.',
  'node-access/already-connected': 'Another agent holds this node lease. Stop that agent or wait for its lease to expire before restarting.',
  'node-access/lease-lost': 'The connection lease expired or changed. The agent will request a new lease.',
  'node-access/unsupported-platform': 'This center accepts macOS, Linux and Windows nodes. Use a supported host.',
  'node-access/unsupported-protocol': 'The center does not accept this control protocol. Install a compatible agent release.',
  'node-access/response-too-large': 'The center metadata exceeds its response limit. Ask an administrator to review directory limits.',
  'node-access/busy': 'The center is at its control-request capacity. The agent will retry the same control operation.',
  'node-access/unavailable': 'Node access is unavailable at this center. Check the center deployment before restarting.',
  'node-access/mode-disabled': 'Multi-computer access is disabled at this entry. Check the primary Gateway address and deployment mode.',
  'node-access/computer-busy': 'Stop this computer’s existing Runtimes before activating its managed connection.',
  'node-access/detached': 'This computer is running independently. Ask an administrator for a new enrollment code before reconnecting.',
  'node-agent/invalid-timing': 'A node timing setting is invalid. Use a positive integer within the Node timer range.',
  'node-agent/center-url-required': 'Set HGW_NODE_CENTER_URL to the center HTTPS origin before starting the agent.',
  'node-agent/invalid-center-url': 'The center URL must be an HTTPS origin without credentials, a path or query fields; loopback HTTP is supported for local verification.',
  'node-agent/invalid-enrollment-token': 'The enrollment token is malformed. Copy the complete ticket from Admin.',
  'node-agent/invalid-dial-urls': 'Each HGW_NODE_CENTER_DIAL_URLS entry must be an HTTPS origin without credentials, a path or query fields; loopback HTTP is supported for local verification; the list holds no empty or duplicate entries.',
  'node-agent/state-unreadable': 'The node credential file cannot be opened. Check its owner, permissions and file type.',
  'node-agent/state-must-be-private': 'The credential file must be private to this operating-system account (mode 0600 on macOS/Linux, an exclusive ACL on Windows). Fix its ownership and permissions before restarting.',
  'node-agent/invalid-state': 'The credential file is invalid. Preserve it and ask an administrator to reissue access into a new private state file.',
  'node-agent/center-identity-mismatch': 'The center identity differs from the saved node identity. Check the center URL and credential file before restarting.',
  'node-agent/pending-enrollment-mismatch': 'This state file contains another pending ticket. Resume it or use a new private state file for the replacement ticket.',
  'node-agent/enrollment-required': 'This node has no credential file. Set HGW_NODE_ENROLLMENT_TOKEN to a ticket issued in Admin.',
  'node-agent/transport-unavailable': 'The center connection is unavailable. The agent will retry the same control operation; check the network if this persists.',
  'node-agent/invalid-response': 'The center returned an invalid or oversized control response. Check the center URL and release compatibility.',
  'node-agent/center-refused': 'The center refused the control request. Check its URL, ingress configuration and release compatibility.',
  'node-agent/unsupported-platform': 'This agent supports macOS, Linux and Windows. Use a supported host.',
  'node-agent/unsupported-architecture': 'This agent supports x64 and arm64 hosts. Use a supported architecture.',
  'node-agent/state-changed': 'The credential file changed during enrollment. Check which process owns that file before restarting.',
  'node-agent/invalid-channel-config': 'A node control-channel limit is invalid. Check HGW_NODE_AGENT_CHANNEL settings before restarting.',
  'node-agent/channel-failed': 'The control-channel supervisor failed locally. The agent will release its connection lease; check the node deployment before restarting.',
}

/**
 * Describe a declared node failure without including secrets or internal exception data.
 * @param code - local diagnostic or authenticated center refusal.
 * @returns affected operation and safe next action for the node operator.
 */
export function nodeAgentFailureMessage(code: NodeAgentErrorCode): string { return FAILURE_MESSAGES[code] }

/** Safe diagnostics exclude tokens, paths, response bodies and underlying network exceptions. */
export class NodeAgentError extends Error {
  /**
   * @param code - local failure or authenticated center refusal.
   * @param retryable - whether the same idempotent control operation may be retried.
   * @param cause - internal diagnostic evidence, never emitted by the CLI.
   * @param refused - a declared center refusal confirms that this request did not acquire a connection lease.
   */
  constructor(readonly code: NodeAgentErrorCode, readonly retryable = false, cause?: unknown, readonly refused = false) {
    super(nodeAgentFailureMessage(code), { cause })
    this.name = 'NodeAgentError'
  }
}

/** Process events contain only public identities and safe, declared failure codes. */
export type NodeAgentEvent =
  | { status: 'enrolled'; nodeId: NodeIdentity['nodeId'] }
  | { status: 'connected'; nodeId: NodeIdentity['nodeId']; epoch: NodeLease['epoch']; executionReady: boolean }
  | { status: 'degraded'; reason: NodeAgentErrorCode }
  | { status: 'stopped' | 'stopped-lease-uncertain' }
  | { status: 'dial-origin'; origin: string; reason: NodeDialReason }
  | NodeChannelClientEvent

function timer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(number) || number > 2_147_483_647) throw new NodeAgentError('node-agent/invalid-timing')
  return number
}

function httpOrigin(value: string, required: NodeAgentErrorCode, invalid: NodeAgentErrorCode): string {
  let url: URL
  try { url = new URL(value) } catch { throw new NodeAgentError(required) }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || url.pathname !== '/') throw new NodeAgentError(invalid)
  return url.origin
}

function centerUrl(value: string | undefined): string {
  return httpOrigin(value ?? '', 'node-agent/center-url-required', 'node-agent/invalid-center-url')
}

function centerDialUrls(value: string | undefined, center: string): string[] {
  if (value === undefined || value.trim() === '') return [center]
  const origins = value.split(',').map(entry => {
    const trimmed = entry.trim()
    if (trimmed === '') throw new NodeAgentError('node-agent/invalid-dial-urls')
    return httpOrigin(trimmed, 'node-agent/invalid-dial-urls', 'node-agent/invalid-dial-urls')
  })
  if (new Set(origins).size !== origins.length) throw new NodeAgentError('node-agent/invalid-dial-urls')
  return origins
}

/**
 * Validate node configuration before filesystem or network acquisition.
 * @param environment - process environment; center HTTPS origin is required, with loopback HTTP for local verification.
 * @returns resolved local state path, transport timing and optional bootstrap ticket.
 */
export function loadNodeAgentConfig(environment: NodeJS.ProcessEnv): NodeAgentConfig {
  const enrollment = environment.HGW_NODE_ENROLLMENT_TOKEN === undefined ? undefined : nodeEnrollmentTokenSchema.safeParse(environment.HGW_NODE_ENROLLMENT_TOKEN)
  if (enrollment !== undefined && !enrollment.success) throw new NodeAgentError('node-agent/invalid-enrollment-token')
  let channel: NodeChannelClientLimits | null
  let localGatewayUrl: string | undefined
  try {
    channel = loadNodeChannelClientLimits(environment)
    if (environment.HGW_NODE_LOCAL_GATEWAY_URL !== undefined) {
      localGatewayUrl = nodeServiceLocalOrigin(environment.HGW_NODE_LOCAL_GATEWAY_URL)
      if (channel === null) throw new Error('The local Gateway bridge requires the control channel')
    }
  }
  catch (error) { throw new NodeAgentError('node-agent/invalid-channel-config', false, error) }
  const url = centerUrl(environment.HGW_NODE_CENTER_URL)
  return {
    centerUrl: url,
    centerDialUrls: centerDialUrls(environment.HGW_NODE_CENTER_DIAL_URLS, url),
    dialPreferredRetryMs: timer(environment.HGW_NODE_AGENT_DIAL_PREFERRED_RETRY_MS, 60_000),
    stateFile: resolve(environment.HGW_NODE_AGENT_STATE_FILE ?? join(homedir(), '.dsh-node', 'access.json')),
    ...(enrollment?.success ? { enrollmentToken: enrollment.data } : {}),
    requestTimeoutMs: timer(environment.HGW_NODE_AGENT_REQUEST_TIMEOUT_MS, 10_000),
    retryMs: timer(environment.HGW_NODE_AGENT_RETRY_MS, 3_000),
    ...(channel === null ? {} : { channel }),
    ...(localGatewayUrl === undefined ? {} : { localGatewayUrl, maxServices: timer(environment.HGW_NODE_AGENT_SERVICE_MAX_CONNECTIONS, 16) }),
  }
}

const stateSchema = z.object({
  version: z.literal(1), centerUrl: z.string(), credential: nodeCredentialSchema,
  enrollmentToken: nodeEnrollmentTokenSchema.nullable(), identity: nodeIdentitySchema.nullable(),
}).strict().refine(value => (value.identity === null) === (value.enrollmentToken !== null))
type AgentState = z.infer<typeof stateSchema>

async function readState(file: string): Promise<AgentState | undefined> {
  let handle
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new NodeAgentError('node-agent/state-unreadable', false, error)
  }
  try {
    const info = await handle.stat()
    const privacy = await privateFileState(file, info, 4096)
    if (privacy === 'unreadable') throw new NodeAgentError('node-agent/state-unreadable')
    if (privacy !== 'private') throw new NodeAgentError('node-agent/state-must-be-private')
    const bytes = Buffer.alloc(4097)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const next = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (next.bytesRead === 0) break
      bytesRead += next.bytesRead
    }
    if (bytesRead > 4096) throw new NodeAgentError('node-agent/invalid-state')
    let value: unknown
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) } catch { throw new NodeAgentError('node-agent/invalid-state') }
    const parsed = stateSchema.safeParse(value)
    if (!parsed.success) throw new NodeAgentError('node-agent/invalid-state')
    return parsed.data
  } finally { await handle.close() }
}

// Enrollment may commit before its response arrives. Flush the node-generated
// credential before exchange so that a restart can repeat that exact exchange.

async function writeState(file: string, value: AgentState): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, file)
    await tightenPrivateFileAcl(file)
    await syncStateDirectory(dirname(file))
  } finally { await rm(temporary, { force: true }) }
}

async function initialState(config: NodeAgentConfig): Promise<AgentState> {
  const created = await mkdir(dirname(config.stateFile), { recursive: true, mode: 0o700 })
  if (created !== undefined) {
    const parent = dirname(created)
    for (let directory = dirname(config.stateFile);; directory = dirname(directory)) {
      await syncStateDirectory(directory)
      if (directory === parent) break
    }
  }
  return withFileLock(config.stateFile, async () => {
    const found = await readState(config.stateFile)
    if (found !== undefined) {
      if (found.centerUrl !== config.centerUrl) throw new NodeAgentError('node-agent/center-identity-mismatch')
      if (found.identity === null && config.enrollmentToken !== undefined && found.enrollmentToken !== config.enrollmentToken) throw new NodeAgentError('node-agent/pending-enrollment-mismatch')
      return found
    }
    if (config.enrollmentToken === undefined) throw new NodeAgentError('node-agent/enrollment-required')
    const state: AgentState = { version: 1, centerUrl: config.centerUrl,
      credential: `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential,
      enrollmentToken: config.enrollmentToken, identity: null }
    await writeState(config.stateFile, state)
    return state
  })
}

async function request(config: NodeAgentConfig, dialer: NodeDialer, path: string, token: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
  const origin = dialer.current()
  let response: Response
  try {
    response = await fetch(`${origin}/internal/nodes/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'manual', signal: deadline,
    })
  } catch (error) {
    dialer.failed(origin, error)
    throw new NodeAgentError('node-agent/transport-unavailable', true, error)
  }
  const retryableRefusal = response.status === 429 || response.status >= 500
  let value: unknown
  try { value = await readResponseJson(response, 4096) }
  catch (error) {
    if (!response.ok) throw new NodeAgentError('node-agent/center-refused', retryableRefusal, error)
    if (deadline.aborted || !(error instanceof ResponseBodyTooLargeError)) {
      throw new NodeAgentError('node-agent/transport-unavailable', true, error)
    }
    throw new NodeAgentError('node-agent/invalid-response', false, error)
  }
  if (!response.ok) {
    const refusal = z.object({ error: z.enum(NODE_ACCESS_ERROR_CODES) }).safeParse(value)
    throw new NodeAgentError(refusal.success ? refusal.data.error : 'node-agent/center-refused', retryableRefusal,
      undefined, refusal.success && response.status >= 400 && response.status < 500)
  }
  return value
}

function identityMatches(expected: NodeIdentity, found: NodeIdentity): void {
  if (expected.nodeId !== found.nodeId || expected.organizationId !== found.organizationId) throw new NodeAgentError('node-agent/center-identity-mismatch')
}

/**
 * Enroll and maintain one process-specific outbound control lease until cancellation.
 * @param config - resolved local credential path and HTTPS center origin.
 * @param signal - shutdown signal; in-flight I/O and retry waits are canceled before bounded release.
 * @param report - diagnostic sink receiving public IDs and declared failure codes only.
 * @returns after release; an unconfirmed release reports stopped-lease-uncertain and leaves expiry to the center.
 * @throws NodeAgentError for unsupported hosts, invalid local state or nonretryable center refusals.
 */
export async function runNodeAgent(config: NodeAgentConfig, signal: AbortSignal, report: (event: NodeAgentEvent) => void): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') throw new NodeAgentError('node-agent/unsupported-platform')
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new NodeAgentError('node-agent/unsupported-architecture')
  signal.throwIfAborted()
  let state = await initialState(config)
  const verifyExpected = (identity: NodeIdentity): void => {
    if (config.expectedIdentity !== undefined && (identity.organizationId !== config.expectedIdentity.organizationId
      || identity.nodeId !== config.expectedIdentity.nodeId)) throw new NodeAgentError('node-agent/center-identity-mismatch')
  }
  if (state.identity !== null) verifyExpected(state.identity)
  const connectionId = randomUUID()
  const dialer = new NodeDialer(config.centerDialUrls, config.dialPreferredRetryMs,
    (origin, reason) => { report({ status: 'dial-origin', origin, reason }) })
  let lease: NodeLease | undefined
  let mayHaveLease = false
  let degraded: NodeAgentErrorCode | undefined
  let channel: { stop: AbortController; completion: Promise<void> } | undefined
  const channelFailure = new AbortController()
  const stopChannel = async () => {
    if (channel === undefined) return
    channel.stop.abort()
    await channel.completion
    channel = undefined
  }
  try {
    while (!signal.aborted) {
      try {
        if (channelFailure.signal.aborted) throw channelFailure.signal.reason
        if (state.identity === null) {
          const value = await request(config, dialer, 'enroll', state.enrollmentToken!, {
            protocolVersion: 1, credential: state.credential, platform: process.platform, architecture: process.arch,
          }, signal)
          const parsed = nodeIdentitySchema.safeParse(value)
          if (!parsed.success) throw new NodeAgentError('node-agent/invalid-response')
          verifyExpected(parsed.data)
          const next: AgentState = { ...state, identity: parsed.data, enrollmentToken: null }
          await withFileLock(config.stateFile, async () => {
            const current = await readState(config.stateFile)
            if (current?.credential !== state.credential || current.centerUrl !== state.centerUrl) throw new NodeAgentError('node-agent/state-changed')
            await writeState(config.stateFile, next)
          })
          state = next
          report({ status: 'enrolled', nodeId: parsed.data.nodeId })
        }
        const acquiring = lease === undefined
        const previousAcquisition = mayHaveLease
        mayHaveLease = true
        let value: unknown
        try {
          value = lease === undefined ? await request(config, dialer, 'connect', state.credential, { connectionId, executionReady: config.localGatewayUrl !== undefined }, signal)
            : await request(config, dialer, 'heartbeat', state.credential, { connectionId, epoch: lease.epoch }, signal)
        } catch (error) {
          if (!previousAcquisition && error instanceof NodeAgentError && error.refused) mayHaveLease = false
          throw error
        }
        const parsed = nodeLeaseSchema.safeParse(value)
        if (!parsed.success || parsed.data.connectionId !== connectionId
          || (lease !== undefined && parsed.data.epoch !== lease.epoch)) throw new NodeAgentError('node-agent/invalid-response')
        identityMatches(state.identity!, parsed.data)
        lease = parsed.data
        if (acquiring && config.channel !== undefined) {
          const stop = new AbortController()
          const completion = runNodeChannel({ dialer, credential: state.credential, lease,
            limits: config.channel, requestTimeoutMs: config.requestTimeoutMs, retryMs: config.retryMs,
            ...(config.localGatewayUrl === undefined ? {} : { localGatewayUrl: config.localGatewayUrl, maxServices: config.maxServices }) },
          AbortSignal.any([signal, stop.signal]), report).catch(error => {
            channelFailure.abort(new NodeAgentError('node-agent/channel-failed', false, error))
          })
          channel = { stop, completion }
        }
        if (acquiring || degraded !== undefined) report({ status: 'connected', nodeId: lease.nodeId, epoch: lease.epoch, executionReady: lease.executionReady })
        degraded = undefined
        await delay(lease.heartbeatMs, undefined, { signal: AbortSignal.any([signal, channelFailure.signal]) })
      } catch (error) {
        if (signal.aborted) break
        if (channelFailure.signal.aborted) throw channelFailure.signal.reason
        if (error instanceof NodeAgentError && error.refused && ['node-access/detached', 'node-access/mode-disabled'].includes(error.code)) {
          await stopChannel(); lease = undefined; mayHaveLease = false
          return
        }
        if (error instanceof NodeAgentError && error.refused && error.code === 'node-access/lease-lost') {
          await stopChannel()
          lease = undefined
          mayHaveLease = false
        }
        else if (!(error instanceof NodeAgentError) || !error.retryable) throw error
        const reason = error instanceof NodeAgentError ? error.code : 'node-agent/transport-unavailable'
        if (reason !== degraded) report({ status: 'degraded', reason })
        degraded = reason
        try { await delay(config.retryMs, undefined, { signal }) } catch (waiting) { if (!signal.aborted) throw waiting }
      }
    }
  } finally {
    await stopChannel()
    if (lease !== undefined) {
      try {
        await request(config, dialer, 'disconnect', state.credential, { connectionId, epoch: lease.epoch }, AbortSignal.timeout(config.requestTimeoutMs))
        mayHaveLease = false
      } catch (error) {
        if (!(error instanceof NodeAgentError)) throw error
        report({ status: 'degraded', reason: error.code })
      }
    }
    report({ status: mayHaveLease ? 'stopped-lease-uncertain' : 'stopped' })
  }
}
