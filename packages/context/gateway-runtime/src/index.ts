/**
 * Gateway-launched runtime identity and authenticated loopback transport.
 * @module @deepseek-ai/dsh-gateway-runtime
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, createPublicKey, randomUUID, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import Schema from '@deepseek-ai/schemastery'
import { publishWorkspaceCatalog } from './workspace-catalog.ts'
import { launchAuthorityOf } from './launch-authority.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  ConnectionAuthenticationRequest,
  ConnectionHttpHandler,
  ConnectionRequestBoundary,
} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-execution-authority'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { StreamPrincipalLeasePool, type StreamPrincipalRenewalConfig } from './stream-principal-leases.ts'
export type { StreamPrincipalRenewalConfig } from './stream-principal-leases.ts'
import type {} from '@deepseek-ai/dsh-resource-budget'
import type {} from '@deepseek-ai/dsh-model-access'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

const runtimeExecutionNamespace = settingsNamespace('runtime-execution')
interface RuntimeExecutionSettings { mode: 'resident' | 'on-demand' }
const runtimeExecutionSchema: Schema<RuntimeExecutionSettings> = Schema.object({
  mode: Schema.union([
    Schema.const('resident').extra('description', { en: 'Keep running', zh: '保持运行' }),
    Schema.const('on-demand').extra('description', { en: 'On demand', zh: '按需运行' }),
  ]).default('resident').extra('description', {
    en: 'Keep resident for timers and listeners. On-demand requires plugins to report background obligations.',
    zh: '定时任务和持续监听应保持运行；按需仅适用于已声明后台占用的插件。',
  }),
})

/** HTTP header carrying one Gateway-signed browser principal. */
export const GATEWAY_PRINCIPAL_HEADER = 'x-dsh-gateway-principal'

/** Private runtime HTTP path used by the Gateway's authenticated readiness probe. */
export const GATEWAY_READINESS_PATH = '/api/internal/gateway/readiness'

/** Managed webhook dispatch route; `webhook-dispatch` assertions are confined to it. */
export const GATEWAY_WEBHOOK_DISPATCH_PATH = '/api/internal/gateway/webhook-dispatch'
/** One-time nonce header for the Gateway readiness challenge. */
export const GATEWAY_READINESS_NONCE_HEADER = 'x-dsh-gateway-readiness-nonce'
/** HMAC challenge proof header. */
export const GATEWAY_READINESS_REQUEST_HEADER = 'x-dsh-gateway-readiness-request'
/** HMAC response proof header. */
export const GATEWAY_READINESS_RESPONSE_HEADER = 'x-dsh-gateway-readiness-response'

/** Runtime identity bound into both the launch credential and every principal. */
export interface GatewayRuntimeIdentity {
  readonly kind: 'user' | 'project'
  readonly id: number
  readonly generation: number
  /** Stable allocated environment; absent only in legacy single-assignment compositions. */
  readonly runtimeId?: Branded<'GatewayRuntimeId'>
}

/** Scope selected by the authenticated browser request. */
export type GatewayPrincipalScope =
  | { kind: 'personal' }
  | { kind: 'project'; projectId: number; projectName: string; mode: 'ro' | 'rw'; canManage?: boolean }

/** Validated Gateway assertion claims available for one request. */
export interface GatewayPrincipalClaims {
  version: 1
  issuer: 'harness-gateway'
  audience: 'dsh-runtime'
  organization: string
  user: {
    id: number
    username: string
    displayName: string
    role: 'admin' | 'user'
  }
  scope: GatewayPrincipalScope
  runtime: GatewayRuntimeIdentity
  issuedAt: number
  expiresAt: number
  nonce: string
  /** Optional capability purpose used by loopback-only runtime integrations. */
  purpose?: 'archive-read' | 'document-admin' | 'terminal-admin' | 'plugin-admin' | 'webhook-dispatch'
}

/** Private launch credential delivered through an inherited FD or systemd credential file. */
export interface GatewayRuntimeCredential {
  version: 1
  gatewayUrl: string
  organization: string
  runtime: GatewayRuntimeIdentity
  token: string
  principalPublicKey: string
  /** Present only when this managed release enables private event-connection renewal. */
  streamPrincipalRenewal?: StreamPrincipalRenewalConfig
}

/** Request-local assertion and its verified claims. */
export interface GatewayRequestPrincipal {
  assertion: string
  claims: GatewayPrincipalClaims
  /** Finite socket authority for a renewable event connection; absent for fixed HTTP assertions. */
  readonly signal?: AbortSignal
}

/** Opaque Gateway capability for one delayed project-root materialization. */
export type GatewaySessionCreationAuthorization = Branded<'GatewaySessionCreationAuthorization'>

/**
 * Brand one validated non-empty creation authorization returned by the Gateway.
 * @param value Validated wire authorization.
 * @returns The opaque authorization accepted by Gateway-backed persistence.
 */
export function GatewaySessionCreationAuthorization(value: string): GatewaySessionCreationAuthorization {
  if (value === '') throw new Error('Gateway session creation authorization must not be empty')
  return value as GatewaySessionCreationAuthorization
}

/** Options for one authenticated call to the Gateway's internal runtime API. */
export interface GatewayRuntimeRequestInit extends RequestInit {
  /** Node's half-duplex upload mode, required when the body is a ReadableStream. */
  duplex?: 'half'
  /** Forward the current browser principal when this operation needs user authority. */
  principal?: boolean | GatewayRequestPrincipal
}

/** Default byte budget for JSON bodies returned by the private Gateway API. */
export const DEFAULT_GATEWAY_RESPONSE_MAX_BYTES = 64 * 1024 * 1024

/** Raised before parsing when a private Gateway response exceeds its byte budget. */
export class GatewayResponseTooLargeError extends Error {
  /** @param limit - maximum accepted UTF-8 response bytes. */
  constructor(readonly limit: number) {
    super(`Gateway response exceeds the ${String(limit)}-byte limit`)
    this.name = 'GatewayResponseTooLargeError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gatewayRuntime: GatewayRuntime
  }
}

/* jscpd:ignore-start -- identical boundary guards are kept local to each capability package. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validRuntimeId(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}
/* jscpd:ignore-end */

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Request cancellation without waiting for another branch of a shared body. */
function cancelResponseRead(source: { cancel(): Promise<void> }): void {
  void source.cancel().catch((_cancellationFailure: unknown) => {
    // The read has already failed; cleanup acknowledgement cannot replace its cause.
  })
}

/** Read one response chunk while allowing the caller to cancel the body. */
async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read()
  if (signal.aborted) {
    cancelResponseRead(reader)
    throw signal.reason instanceof Error ? signal.reason : new Error('Gateway response read was cancelled', { cause: signal.reason })
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const finish = (): boolean => {
      if (settled) return false
      settled = true
      cleanup()
      return true
    }
    const onAbort = (): void => {
      if (!finish()) return
      cancelResponseRead(reader)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Gateway response read was cancelled', { cause: signal.reason }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      (value) => { if (finish()) resolve(value) },
      (error: unknown) => {
        if (finish()) reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      },
    )
  })
}

/**
 * Read a private Gateway response without retaining more than the supplied
 * byte budget. The caller owns JSON validation; this helper only bounds the
 * response body and preserves the response stream's cancellation semantics.
 * Failed reads request body cancellation without awaiting its acknowledgement.
 * @param response - response returned by {@link GatewayRuntime.request}.
 * @param limit - positive safe-integer UTF-8 byte budget.
 * @param signal - optional cancellation for the response body read.
 * @returns the complete response bytes.
 */
export async function readGatewayResponseBytes(
  response: Response,
  limit = DEFAULT_GATEWAY_RESPONSE_MAX_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Gateway response byte limit must be a positive safe integer')
  if (signal?.aborted) {
    if (response.body !== null) cancelResponseRead(response.body)
    signal.throwIfAborted()
  }
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      if (response.body !== null) cancelResponseRead(response.body)
      throw new GatewayResponseTooLargeError(limit)
    }
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await readResponseChunk(reader, signal)
      if (next.done) break
      total += next.value.byteLength
      if (!Number.isSafeInteger(total) || total > limit) {
        cancelResponseRead(reader)
        throw new GatewayResponseTooLargeError(limit)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Read and parse a bounded private Gateway JSON response.
 * @param response - response returned by {@link GatewayRuntime.request}.
 * @param limit - positive safe-integer UTF-8 byte budget.
 * @param signal - optional cancellation for the response body read.
 * @returns the decoded JSON value.
 */
export async function readGatewayResponseJson(
  response: Response,
  limit = DEFAULT_GATEWAY_RESPONSE_MAX_BYTES,
  signal?: AbortSignal,
): Promise<unknown> {
  const bytes = await readGatewayResponseBytes(response, limit, signal)
  signal?.throwIfAborted()
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function readinessMaterial(
  kind: 'request' | 'response',
  nonce: string,
  identity: GatewayRuntimeIdentity,
): string {
  return `dsh-gateway-readiness-v1\u0000${kind}\u0000${nonce}\u0000${identity.kind}\u0000${String(identity.id)}\u0000${String(identity.generation)}`
}

function readinessProof(
  kind: 'request' | 'response',
  token: string,
  nonce: string,
  identity: GatewayRuntimeIdentity,
): string {
  return createHmac('sha256', token).update(readinessMaterial(kind, nonce, identity)).digest('base64url')
}

function proofEquals(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false
  const left = Buffer.from(expected, 'base64url')
  const right = Buffer.from(actual, 'base64url')
  return left.length === right.length && timingSafeEqual(left, right)
}

function headerString(
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse and validate one private runtime credential.
 * @param value - decoded credential JSON from the private launch channel.
 * @returns the validated credential.
 */
export function parseGatewayRuntimeCredential(value: unknown): GatewayRuntimeCredential {
  const credential = record(value)
  const runtime = record(credential?.runtime)
  if (credential?.version !== 1 || !nonEmptyString(credential.gatewayUrl)
    || !nonEmptyString(credential.organization) || !nonEmptyString(credential.token)
    || !nonEmptyString(credential.principalPublicKey)
    || (runtime?.kind !== 'user' && runtime?.kind !== 'project')
    || !positiveInteger(runtime.id) || !positiveInteger(runtime.generation) || !validRuntimeId(runtime.runtimeId)) {
    throw new Error('invalid Gateway runtime credential')
  }
  let gatewayUrl: URL
  try {
    gatewayUrl = new URL(credential.gatewayUrl)
  } catch {
    throw new Error('Gateway runtime credential must name a loopback HTTP origin')
  }
  if (gatewayUrl.protocol !== 'http:'
    || (gatewayUrl.hostname !== '127.0.0.1' && gatewayUrl.hostname !== '[::1]' && gatewayUrl.hostname !== 'localhost')
    || gatewayUrl.username !== '' || gatewayUrl.password !== ''
    || gatewayUrl.pathname !== '/' || gatewayUrl.search !== '' || gatewayUrl.hash !== '') {
    throw new Error('Gateway runtime credential must name a loopback HTTP origin')
  }
  createPublicKey(credential.principalPublicKey)
  if (credential.streamPrincipalRenewal !== undefined) {
    const renewal = record(credential.streamPrincipalRenewal)
    if (renewal?.enabled !== true || !positiveInteger(renewal.intervalMs) || renewal.intervalMs > 2_147_483_647
      || !positiveInteger(renewal.requestTimeoutMs) || renewal.requestTimeoutMs > 2_147_483_647
      || !positiveInteger(renewal.maxBatchSize) || renewal.maxBatchSize > 1024) {
      throw new Error('invalid Gateway stream principal renewal configuration')
    }
  }
  return value as GatewayRuntimeCredential
}

function principalClaims(value: unknown): GatewayPrincipalClaims {
  const claims = record(value)
  const user = record(claims?.user)
  const scope = record(claims?.scope)
  const runtime = record(claims?.runtime)
  if (claims?.version !== 1 || claims.issuer !== 'harness-gateway' || claims.audience !== 'dsh-runtime'
    || !nonEmptyString(claims.organization) || !positiveInteger(user?.id)
    || !nonEmptyString(user.username) || typeof user.displayName !== 'string'
    || (user.role !== 'admin' && user.role !== 'user')
    || (scope?.kind !== 'personal' && scope?.kind !== 'project')
    || (runtime?.kind !== 'user' && runtime?.kind !== 'project')
    || !positiveInteger(runtime.id) || !positiveInteger(runtime.generation)
    || !validRuntimeId(runtime.runtimeId)
    || typeof claims.issuedAt !== 'number' || !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt < 0
    || typeof claims.expiresAt !== 'number' || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt || !nonEmptyString(claims.nonce)) {
    throw new Error('invalid Gateway principal assertion')
  }
  if (claims.purpose !== undefined && claims.purpose !== 'archive-read' && claims.purpose !== 'document-admin' && claims.purpose !== 'terminal-admin' && claims.purpose !== 'plugin-admin' && claims.purpose !== 'webhook-dispatch') {
    throw new Error('invalid Gateway principal assertion')
  }
  if (claims.purpose !== undefined && claims.purpose !== 'webhook-dispatch' && user.role !== 'admin') {
    throw new Error('invalid Gateway principal assertion')
  }
  if (scope.kind === 'project' && (!positiveInteger(scope.projectId)
    || !nonEmptyString(scope.projectName) || (scope.mode !== 'ro' && scope.mode !== 'rw')
    || (scope.canManage !== undefined && typeof scope.canManage !== 'boolean'))) {
    throw new Error('invalid Gateway principal assertion')
  }
  return value as GatewayPrincipalClaims
}

/**
 * Verify a compact Ed25519 principal against one runtime credential.
 * @param assertion - compact payload and signature issued by the Gateway.
 * @param credential - runtime identity and verification key for this process.
 * @param publicKey - parsed verification key reused across requests.
 * @param now - current epoch milliseconds for assertion lifetime checks.
 * @returns the validated principal claims.
 */
export function verifyGatewayPrincipal(
  assertion: string,
  credential: GatewayRuntimeCredential,
  publicKey: KeyObject = createPublicKey(credential.principalPublicKey),
  now = Date.now(),
): GatewayPrincipalClaims {
  const parts = assertion.split('.')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error('invalid Gateway principal assertion')
  }
  const payload = parts[0] as string
  const signatureText = parts[1] as string
  const payloadBytes = Buffer.from(payload, 'base64url')
  const signature = Buffer.from(signatureText, 'base64url')
  if (payloadBytes.toString('base64url') !== payload || signature.toString('base64url') !== signatureText
    || !verifySignature(null, Buffer.from(payload), publicKey, signature)) {
    throw new Error('invalid Gateway principal assertion')
  }
  let value: unknown
  try {
    value = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    throw new Error('invalid Gateway principal assertion')
  }
  const claims = principalClaims(value)
  if (claims.organization !== credential.organization
    || claims.runtime.kind !== credential.runtime.kind
    || claims.runtime.id !== credential.runtime.id
    || claims.runtime.generation !== credential.runtime.generation
    || claims.runtime.runtimeId !== credential.runtime.runtimeId
    || claims.issuedAt > now || claims.expiresAt <= now) {
    throw new Error('expired or foreign Gateway principal assertion')
  }
  if (claims.scope.kind === 'personal') {
    if (claims.runtime.kind !== 'user'
      || (claims.user.id !== claims.runtime.id && claims.purpose !== 'archive-read' && claims.purpose !== 'document-admin' && claims.purpose !== 'terminal-admin' && claims.purpose !== 'plugin-admin' && claims.purpose !== 'webhook-dispatch')) {
      throw new Error('invalid Gateway principal assertion scope')
    }
  } else if (claims.runtime.kind !== 'project' || claims.scope.projectId !== claims.runtime.id) {
    throw new Error('invalid Gateway principal assertion scope')
  }
  return claims
}

function credentialText(env: NodeJS.ProcessEnv): string {
  const fdText = env.DSH_GATEWAY_CREDENTIAL_FD
  const path = env.DSH_GATEWAY_CREDENTIAL_FILE
  if (fdText !== undefined && path !== undefined) {
    throw new Error('configure exactly one Gateway runtime credential source')
  }
  if (fdText !== undefined) {
    const fd = Number(fdText)
    if (!Number.isSafeInteger(fd) || fd < 3) throw new Error('invalid DSH_GATEWAY_CREDENTIAL_FD')
    return readFileSync(fd, 'utf8')
  }
  if (path !== undefined && path !== '') return readFileSync(path, 'utf8')
  throw new Error('Gateway runtime credential is unavailable')
}

/**
 * Read the launch credential from its private process channel.
 * Each call consumes the selected descriptor; application providers retain the validated result.
 * @param env - process environment naming exactly one credential source.
 * @returns the validated private runtime credential.
 * @throws when the channel or credential is invalid; JSON diagnostics omit credential contents.
 */
export function readGatewayRuntimeCredential(env: NodeJS.ProcessEnv = process.env): GatewayRuntimeCredential {
  let text: string
  try {
    text = credentialText(env)
  } catch (error: unknown) {
    throw new Error(`failed to read Gateway runtime credential: ${String(error)}`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Engine syntax errors can include private credential bytes in their message.
    throw new Error('failed to read Gateway runtime credential: invalid JSON')
  }
  return parseGatewayRuntimeCredential(value)
}

const PLUGIN_MANAGEMENT_PATHS = new Set([
  'access', 'catalog', 'listVersionExemptions', 'setVersionExemption', 'listPlugins', 'listBundles', 'registries',
  'inspect', 'setPluginEnabled', 'describePluginConfig', 'setPluginConfig', 'setBundleEnabled', 'installBundle', 'waitForInstall', 'cancelInstall', 'removeBundle',
].map(method => `/api/pluginManager/${method}`))
PLUGIN_MANAGEMENT_PATHS.add('/api/pluginInventory/list')
PLUGIN_MANAGEMENT_PATHS.add('/api/settings.describe')
PLUGIN_MANAGEMENT_PATHS.add('/api/settings.mutate')
PLUGIN_MANAGEMENT_PATHS.add('/api/_stream/pluginManager/installBundleStream')

/** Managed readiness and Workspace metadata publication settings. */
export interface Config {
  /** Maximum duration of a Workspace catalog publication, in milliseconds. */
  workspaceCatalogTimeoutMs?: number
  /** Loader entry ids that must each have one active instance before readiness; absent means no additional entries. */
  requiredPlugins?: string[]
}

/** Authenticated Gateway context whose application retains launch identity across provider replacement. */
export class GatewayRuntime extends Service {
  static inject = ['connection']
  static Config: Schema<Config> = Schema.object({
    workspaceCatalogTimeoutMs: Schema.natural().min(1).default(30_000),
    requiredPlugins: Schema.array(Schema.string().min(1)).default([]),
  })

  /** Non-sensitive runtime identity bound to every accepted principal. */
  readonly identity: GatewayRuntimeIdentity
  /** Gateway organization bound to this runtime. */
  readonly organization: string

  private readonly credential: GatewayRuntimeCredential
  private readonly gatewayUrl: URL
  private readonly publicKey: KeyObject
  private readonly requests = new AsyncLocalStorage<{ principal: GatewayRequestPrincipal; interactive: boolean }>()
  private readonly readinessRequests = new AsyncLocalStorage<string>()
  private readonly sessionCreations = new Map<SessionId, Promise<GatewaySessionCreationAuthorization>>()
  private readonly readinessPlugins: readonly string[]
  private readonly streamPrincipals: StreamPrincipalLeasePool | undefined
  private executionSettings: () => RuntimeExecutionSettings = () => ({ mode: 'resident' })

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'gatewayRuntime')
    this.readinessPlugins = [...new Set(config.requiredPlugins ?? [])]
    installSettingsSection(ctx, runtimeExecutionNamespace, runtimeExecutionSchema, { mode: 'resident' }, {
      label: { en: 'Runtime execution', zh: '运行时策略' },
      owner: 'project',
      projectWrite: 'manager',
      setSource: (source) => { this.executionSettings = source },
      onChange: () => {},
    })
    const authority = launchAuthorityOf(ctx, () => {
      const credential = readGatewayRuntimeCredential()
      return { credential, publicKey: createPublicKey(credential.principalPublicKey) }
    })
    this.credential = authority.credential
    this.identity = { ...this.credential.runtime }
    this.organization = this.credential.organization
    this.gatewayUrl = new URL(this.credential.gatewayUrl)
    this.publicKey = authority.publicKey
    this.streamPrincipals = this.credential.streamPrincipalRenewal === undefined ? undefined : new StreamPrincipalLeasePool({
      config: this.credential.streamPrincipalRenewal,
      verify: assertion => verifyGatewayPrincipal(assertion, this.credential, this.publicKey),
      renew: async (leaseIds, signal) => {
        const response = await this.request('/internal/runtime/stream-principals/renew', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, leaseIds }), signal,
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error('Gateway event connection renewal is unavailable')
        }
        return readGatewayResponseJson(response, 4 * 1024 * 1024, signal)
      },
      reportUnavailable: () => { ctx.logger.warn('Gateway event connection renewal failed; reconnect if the signed authority expires.') },
    })
    ctx.effect(() => () => this.streamPrincipals?.close(), 'gateway-runtime: event connection principal leases')
    if (this.identity.kind === 'user') {
      ctx.inject(['workspaceRegistry', 'apiProxy'], (scope) => {
        publishWorkspaceCatalog(scope, this, config.workspaceCatalogTimeoutMs ?? 30_000, async () => {
          const response = await scope.apiProxy.sessions.list({ rpcId: RpcId(randomUUID()), payload: {} })
          if (!response.result.ok) throw new Error(`Personal conversation metadata is unavailable: ${response.result.error.code}`)
          return response.result.value.items
        })
      })
    } else {
      ctx.inject(['workspaceRegistry'], (scope) => {
        publishWorkspaceCatalog(scope, this, config.workspaceCatalogTimeoutMs ?? 30_000)
      })
    }
    if (ctx.root.get('modelAccessRequired') !== true) {
      ctx.root.effect(() => ctx.root.provide('modelAccessRequired', true),
        'gateway-runtime: managed model authorization')
    }
    if (ctx.root.get('resourceBudgetRequired') !== true) {
      ctx.root.effect(() => ctx.root.provide('resourceBudgetRequired', true),
        'gateway-runtime: managed resource admission')
    }
    if (ctx.root.get('executionAuthorityRequired') !== true) {
      ctx.root.effect(() => ctx.root.provide('executionAuthorityRequired', true),
        'gateway-runtime: managed application identity')
    }
    if (this.identity.kind === 'project' && ctx.root.get('collaborationRequired') !== true) {
      ctx.root.effect(() => ctx.root.provide('collaborationRequired', true),
        'gateway-runtime: shared project authorization policy')
    }
    // Connection consults this provider before its token exchange and cookie;
    // a gateway-launched runtime admits only verified principal assertions, so
    // every absent or invalid answer is a denial. The `connection/request`
    // waterfall stays the sole owner of AsyncLocalStorage propagation.
    ctx.on('connection/authenticate', (request: ConnectionAuthenticationRequest): 'allow' | 'deny' => {
      const header = headerString(request.headers, GATEWAY_PRINCIPAL_HEADER)
      if (header === undefined) return 'deny'
      let claims: GatewayPrincipalClaims
      try {
        claims = verifyGatewayPrincipal(header, this.credential, this.publicKey)
      } catch {
        // Refuse invalid assertions without quoting any of their bytes.
        return 'deny'
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.invalid').pathname
      try {
        this.assertPurposePermitted(claims, request.kind, request.method, pathname)
      } catch {
        return 'deny'
      }
      return 'allow'
    })
    ctx.inject(['webServer'], (scope) => {
      scope.on('webserver/index-inject', (rows, request) => {
        if (request === undefined) return
        const header = headerString(request.headers, GATEWAY_PRINCIPAL_HEADER)
        if (header === undefined) throw new Error('Gateway index principal assertion is required')
        const claims = verifyGatewayPrincipal(header, this.credential, this.publicKey)
        this.assertPurposePermitted(claims, 'index', request.method, new URL(request.url ?? '/', 'http://dsh.invalid').pathname)
        rows.push({ kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: {
          version: 1,
          principalId: claims.user.id,
          runtimeTarget: claims.scope.kind === 'personal' ? { kind: 'personal' }
            : { kind: 'project', projectId: claims.scope.projectId },
        } })
      })
    })
    ctx.on('connection/request', (request: ConnectionRequestBoundary, next) => {
      const requestMeta = request as ConnectionRequestBoundary & { method?: string; pathname?: string }
      const header = request.headers[GATEWAY_PRINCIPAL_HEADER]
      const readinessNonce = headerString(request.headers, GATEWAY_READINESS_NONCE_HEADER)
      const readinessRequest = headerString(request.headers, GATEWAY_READINESS_REQUEST_HEADER)
      if (request.kind === 'http' && requestMeta.method === 'GET' && requestMeta.pathname === GATEWAY_READINESS_PATH
        && readinessNonce !== undefined && readinessRequest !== undefined
        && proofEquals(
          readinessProof('request', this.credential.token, readinessNonce, this.identity),
          readinessRequest,
        )) {
        return this.readinessRequests.run(readinessNonce, next)
      }
      if (typeof header !== 'string') throw new Error('Gateway principal assertion is required')
      let principal: GatewayRequestPrincipal = {
        assertion: header,
        claims: verifyGatewayPrincipal(header, this.credential, this.publicKey),
      }
      this.assertPurposePermitted(principal.claims, request.kind, requestMeta.method, requestMeta.pathname)
      if (request.kind === 'upgrade' && request.signal !== undefined
        && (requestMeta.pathname === '/api/events.mux' || requestMeta.pathname === '/api/events.host')
        && this.streamPrincipals !== undefined) {
        principal = this.streamPrincipals.open(principal, request.signal)
      }
      const requestScope = { principal, interactive: request.kind === 'http' }
      return this.requests.run(requestScope, async () => {
        try { await next() } finally { requestScope.interactive = false }
      })
    })
    const connection = ctx.get('connection')
    if (connection === undefined) throw new Error('gateway runtime requires the connection service')
    const http = (connection as unknown as {
      http?: { handlePrefix?: (path: string, handler: ConnectionHttpHandler, options: { authority: 'loopback' }) => () => Promise<void> }
    }).http
    const handlePrefix = http?.handlePrefix
    if (typeof handlePrefix === 'function') {
      ctx.effect(
        () => handlePrefix(
          GATEWAY_READINESS_PATH,
          (request: IncomingMessage, response: ServerResponse) => { this.handleReadiness(request, response) },
          { authority: 'loopback' },
        ),
        'gateway-runtime: readiness endpoint',
      )
    }
  }

  /**
   * Bound a capability-purpose assertion to its declared HTTP operations.
   * Each purpose accepts only its declared HTTP methods and paths; no purpose
   * serves the index or opens an event stream.
   * @param claims - verified assertion claims.
   * @param kind - carrier the assertion arrives on: index, HTTP, or upgrade.
   * @param method - request method, when the carrier reports one.
   * @param pathname - request pathname, when the carrier reports one.
   */
  private assertPurposePermitted(
    claims: GatewayPrincipalClaims,
    kind: 'index' | 'http' | 'upgrade',
    method: string | undefined,
    pathname: string | undefined,
  ): void {
    if (claims.purpose === 'archive-read' && (method !== 'GET' || kind !== 'http'
      || pathname !== '/api/internal/archive/read')) {
      throw new Error('Archive assertions permit only the archive read endpoint.')
    }
    if (claims.purpose === 'document-admin' && (kind !== 'http'
      || !((method === 'POST' && (pathname === '/api/documents/trash' || pathname === '/api/documents/restore'))
        || (method === 'DELETE' && pathname === '/api/documents/purge')))) {
      throw new Error('Document management assertions permit only trash, restore and purge.')
    }
    if (claims.purpose === 'terminal-admin' && (method !== 'POST' || kind !== 'http'
      || (pathname !== '/api/terminal/adminList' && pathname !== '/api/terminal/adminClose'))) {
      throw new Error('Terminal management assertions permit only inventory and termination.')
    }
    if (claims.purpose === 'plugin-admin' && (method !== 'POST' || kind !== 'http'
      || !PLUGIN_MANAGEMENT_PATHS.has(pathname ?? ''))) {
      throw new Error('Plugin management assertions permit only profile management HTTP endpoints.')
    }
    if (claims.purpose === 'webhook-dispatch' && (method !== 'POST' || kind !== 'http'
      || pathname !== GATEWAY_WEBHOOK_DISPATCH_PATH)) {
      throw new Error('Webhook dispatch assertions permit only the managed dispatch endpoint.')
    }
    if (claims.purpose !== undefined && kind !== 'http') {
      throw new Error('Purpose assertions permit only their declared HTTP operations.')
    }
  }

  /** Serve one authenticated readiness challenge after the connection middleware accepted it. */
  private handleReadiness(_request: IncomingMessage, response: ServerResponse): void {
    const nonce = this.readinessRequests.getStore()
    if (nonce === undefined) {
      response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'readiness-proof-required' }))
      return
    }
    if (this.ctx.get('resourceBudget') === undefined) {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'resource-admission-unavailable' }))
      return
    }
    if (this.readinessPlugins.length > 0) {
      const entries = [...this.ctx.get('loader')?.entries() ?? []]
      if (this.readinessPlugins.some((id) => {
        const matching = entries.filter(entry => entry.options.id === id)
        return matching.length !== 1 || matching[0]?.fiber?.state !== FiberState.ACTIVE
      })) {
        response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: 'required-plugins-unavailable' }))
        return
      }
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    const policy = this.executionSettings().mode
    let canStop = false
    try { canStop = policy === 'on-demand' && this.canReleaseRuntime() }
    catch (error) {
      this.ctx.logger.warn('Runtime idle check failed; keeping the process running (%s).', error instanceof Error ? error.name : 'unknown')
    }
    const idleMaterial = `dsh-gateway-idle-v1\u0000${nonce}\u0000${this.identity.kind}\u0000${String(this.identity.id)}\u0000${String(this.identity.generation)}\u0000${policy}\u0000${String(canStop)}`
    response.end(JSON.stringify({
      version: 1,
      runtime: this.identity,
      proof: readinessProof('response', this.credential.token, nonce, this.identity),
      idle: { policy, canStop, proof: createHmac('sha256', this.credential.token).update(idleMaterial).digest('base64url') },
    }))
  }

  private canReleaseRuntime(): boolean {
    if (this.ctx.root.fiber.state !== FiberState.ACTIVE || this.ctx.fiber.state !== FiberState.ACTIVE) return false
    const agents = this.ctx.get('agents')
    const loader = this.ctx.get('loader')
    if (agents === undefined || loader === undefined) return false
    if ([...loader.entries()].some(entry => entry.fiber === undefined
      ? !entry.disabled
      : entry.fiber.state !== FiberState.ACTIVE && !(entry.disabled && entry.fiber.state === FiberState.DISPOSED))) return false
    if (this.ctx.bail('runtime/idle-release-check') === 'busy') return false
    const live = agents.list()
    if (agents.roots().length !== live.length) return false
    return live.every(agent => agent.status === 'idle'
      && agent.inbox.nextStep.length === 0 && agent.inbox.nextTurn.length === 0
      && this.ctx.bail(agentCarrier(agent), 'agent/idle-release-check', { agent }) !== 'busy')
  }

  /**
   * Return the principal bound to the current HTTP or WebSocket operation.
   * @returns the verified principal, or undefined outside an authenticated operation.
   */
  current(): GatewayRequestPrincipal | undefined {
    return this.requests.getStore()?.principal
  }

  /**
   * Read the live HTTP caller; detached work cannot keep interactive authority.
   * @returns the caller while the HTTP operation remains active, otherwise undefined.
   */
  interactive(): GatewayRequestPrincipal | undefined {
    const scope = this.requests.getStore()
    return scope?.interactive === true ? scope.principal : undefined
  }

  /**
   * Return the current principal or reject an operation outside an authenticated request.
   * @returns the verified principal bound to the current operation.
   */
  requireCurrent(): GatewayRequestPrincipal {
    const principal = this.current()
    if (principal === undefined) throw new Error('Gateway request principal is unavailable')
    return principal
  }

  /**
   * Publish one pending lazy-creation capability for other Gateway Consumers.
   * @param sessionId - project root whose first append will materialize it.
   * @param authorization - in-flight or resolved Gateway capability.
   * @returns an exact-registration disposer.
   */
  registerSessionCreation(
    sessionId: SessionId,
    authorization: Promise<GatewaySessionCreationAuthorization>,
  ): () => void {
    const existing = this.sessionCreations.get(sessionId)
    if (existing !== undefined && existing !== authorization) {
      throw new Error(`session "${sessionId}" already has a pending Gateway creation authorization`)
    }
    this.sessionCreations.set(sessionId, authorization)
    return () => {
      if (this.sessionCreations.get(sessionId) === authorization) this.sessionCreations.delete(sessionId)
    }
  }

  /**
   * Read the pending lazy-creation capability for one project root.
   * @param sessionId - candidate project root.
   * @returns the capability promise, or undefined after materialization or rollback.
   */
  sessionCreation(sessionId: SessionId): Promise<GatewaySessionCreationAuthorization> | undefined {
    return this.sessionCreations.get(sessionId)
  }

  /**
   * Call the authenticated loopback API without exposing its bearer token to other plugins.
   * @param path - absolute internal runtime API path.
   * @param options - fetch options and optional current-principal forwarding.
   * @returns the Gateway HTTP response.
   */
  request(path: string, options: GatewayRuntimeRequestInit = {}): Promise<Response> {
    const rawPathname = path.split(/[?#]/, 1)[0] ?? ''
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')
      || rawPathname.split('/').some(segment => segment === '.' || segment === '..')
      || /%(?:25)*2e/i.test(rawPathname)) {
      throw new Error(`invalid Gateway runtime API path: ${path}`)
    }
    const target = new URL(path, this.gatewayUrl)
    if (target.origin !== this.gatewayUrl.origin || !target.pathname.startsWith('/internal/runtime/')) {
      throw new Error(`invalid Gateway runtime API path: ${path}`)
    }
    const { principal = false, ...init } = options
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.credential.token}`)
    if (principal === true) headers.set(GATEWAY_PRINCIPAL_HEADER, this.requireCurrent().assertion)
    else if (principal !== false) headers.set(GATEWAY_PRINCIPAL_HEADER, principal.assertion)
    else headers.delete(GATEWAY_PRINCIPAL_HEADER)
    return fetch(target, { ...init, headers })
  }
}

export default GatewayRuntime
