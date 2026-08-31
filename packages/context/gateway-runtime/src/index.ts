/**
 * Gateway-launched runtime identity and authenticated loopback transport.
 * @module @deepseek-ai/dsh-gateway-runtime
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ConnectionHttpHandler, ConnectionRequestBoundary } from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** HTTP header carrying one Gateway-signed browser principal. */
export const GATEWAY_PRINCIPAL_HEADER = 'x-dsh-gateway-principal'

/** Private runtime HTTP path used by the Gateway's authenticated readiness probe. */
export const GATEWAY_READINESS_PATH = '/api/internal/gateway/readiness'
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
  purpose?: 'archive-read' | 'document-admin'
}

/** Private launch credential delivered through an inherited FD or systemd credential file. */
export interface GatewayRuntimeCredential {
  version: 1
  gatewayUrl: string
  organization: string
  runtime: GatewayRuntimeIdentity
  token: string
  principalPublicKey: string
}

/** Request-local assertion and its verified claims. */
export interface GatewayRequestPrincipal {
  assertion: string
  claims: GatewayPrincipalClaims
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
/* jscpd:ignore-end */

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Read one response chunk while allowing the caller to cancel the body. */
async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read()
  if (signal.aborted) {
    await reader.cancel().catch(() => {})
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
      void reader.cancel().catch(() => {})
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
  signal?.throwIfAborted()
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      await Promise.resolve(response.body?.cancel()).catch(() => {})
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
        await reader.cancel().catch(() => {})
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

function headerString(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
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
    || !positiveInteger(runtime.id) || !positiveInteger(runtime.generation)) {
    throw new Error('invalid Gateway runtime credential')
  }
  const gatewayUrl = new URL(credential.gatewayUrl)
  if (gatewayUrl.protocol !== 'http:'
    || (gatewayUrl.hostname !== '127.0.0.1' && gatewayUrl.hostname !== '::1' && gatewayUrl.hostname !== 'localhost')
    || gatewayUrl.username !== '' || gatewayUrl.password !== ''
    || gatewayUrl.pathname !== '/' || gatewayUrl.search !== '' || gatewayUrl.hash !== '') {
    throw new Error('Gateway runtime credential must name a loopback HTTP origin')
  }
  createPublicKey(credential.principalPublicKey)
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
    || typeof claims.issuedAt !== 'number' || !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt < 0
    || typeof claims.expiresAt !== 'number' || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt || !nonEmptyString(claims.nonce)) {
    throw new Error('invalid Gateway principal assertion')
  }
  if (claims.purpose !== undefined && claims.purpose !== 'archive-read' && claims.purpose !== 'document-admin') {
    throw new Error('invalid Gateway principal assertion')
  }
  if (claims.purpose !== undefined && user.role !== 'admin') {
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
    || claims.issuedAt > now || claims.expiresAt <= now) {
    throw new Error('expired or foreign Gateway principal assertion')
  }
  if (claims.scope.kind === 'personal') {
    if (claims.runtime.kind !== 'user'
      || (claims.user.id !== claims.runtime.id && claims.purpose !== 'archive-read' && claims.purpose !== 'document-admin')) {
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
 * @param env - process environment naming exactly one credential source.
 * @returns the validated private runtime credential.
 */
export function readGatewayRuntimeCredential(env: NodeJS.ProcessEnv = process.env): GatewayRuntimeCredential {
  let value: unknown
  try {
    value = JSON.parse(credentialText(env))
  } catch (error: unknown) {
    throw new Error(`failed to read Gateway runtime credential: ${String(error)}`)
  }
  return parseGatewayRuntimeCredential(value)
}

/** Authenticated Gateway context for one launched Harness runtime. */
export class GatewayRuntime extends Service {
  static inject = ['connection']

  /** Non-sensitive runtime identity bound to every accepted principal. */
  readonly identity: GatewayRuntimeIdentity
  /** Gateway organization bound to this runtime. */
  readonly organization: string

  private readonly credential: GatewayRuntimeCredential
  private readonly gatewayUrl: URL
  private readonly publicKey: KeyObject
  private readonly requests = new AsyncLocalStorage<GatewayRequestPrincipal>()
  private readonly readinessRequests = new AsyncLocalStorage<string>()
  private readonly sessionCreations = new Map<SessionId, Promise<GatewaySessionCreationAuthorization>>()

  constructor(ctx: Context) {
    super(ctx, 'gatewayRuntime')
    this.credential = readGatewayRuntimeCredential()
    this.identity = { ...this.credential.runtime }
    this.organization = this.credential.organization
    this.gatewayUrl = new URL(this.credential.gatewayUrl)
    this.publicKey = createPublicKey(this.credential.principalPublicKey)
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
      const principal = {
        assertion: header,
        claims: verifyGatewayPrincipal(header, this.credential, this.publicKey),
      }
      return this.requests.run(principal, next)
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

  /** Serve one authenticated readiness challenge after the connection middleware accepted it. */
  private handleReadiness(_request: IncomingMessage, response: ServerResponse): void {
    const nonce = this.readinessRequests.getStore()
    if (nonce === undefined) {
      response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'readiness-proof-required' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({
      version: 1,
      runtime: this.identity,
      proof: readinessProof('response', this.credential.token, nonce, this.identity),
    }))
  }

  /**
   * Return the principal bound to the current HTTP or WebSocket operation.
   * @returns the verified principal, or undefined outside an authenticated operation.
   */
  current(): GatewayRequestPrincipal | undefined {
    return this.requests.getStore()
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
