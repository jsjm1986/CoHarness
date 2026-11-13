import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { UserRow } from './auth.ts'
import type { RuntimeId } from './runtime-catalog.ts'

export const PRINCIPAL_HEADER = 'x-dsh-gateway-principal'

/** Narrow purpose carried by a Gateway assertion that is not a browser request. */
export type GatewayPrincipalPurpose = 'archive-read' | 'document-admin' | 'terminal-admin' | 'plugin-admin' | 'webhook-dispatch'

export type PrincipalScope =
  | { kind: 'personal' }
  | {
      kind: 'project'
      projectId: number
      projectName: string
      mode: 'ro' | 'rw'
      canManage?: boolean
      /** True when the scope is the reserved steward maintenance space. */
      steward?: boolean
    }

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
  scope: PrincipalScope
  runtime: {
    kind: 'user' | 'project'
    id: number
    generation: number
    runtimeId?: RuntimeId
  }
  issuedAt: number
  expiresAt: number
  nonce: string
  /** Optional capability purpose; ordinary browser assertions omit it. */
  purpose?: GatewayPrincipalPurpose
}

/** Immutable runtime session header bound into a delayed-creation authorization. */
export interface GatewaySessionCreationHeader {
  id: string
  version: number
  createdAt: number
  cwd?: string
  parentSession?: string
  seedLength?: number
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
  draft?: boolean
  /** Registered SSH target public id bound to this session's execution, when any. */
  sshTarget?: number
}

/** Durable Gateway authorization for atomically materializing one project root. */
export interface GatewaySessionCreationClaims {
  version: 1
  issuer: 'harness-gateway'
  audience: 'dsh-session-creation'
  organization: string
  creatorUserId: number
  runtime: {
    kind: 'project'
    id: number
    generation: number
    runtimeId?: RuntimeId
  }
  header: GatewaySessionCreationHeader
  visibility: 'project' | 'private'
  issuedAt: number
  nonce: string
}

function signedPayload(value: unknown, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64url')
  return `${payload}.${signature}`
}

export function verifiedPayload(assertion: string, publicKey: KeyObject, label: string): unknown {
  const parts = assertion.split('.')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') throw new Error(`invalid ${label}`)
  const payload = parts[0]!
  const signatureText = parts[1]!
  const payloadBytes = Buffer.from(payload, 'base64url')
  const signature = Buffer.from(signatureText, 'base64url')
  if (payloadBytes.toString('base64url') !== payload || signature.toString('base64url') !== signatureText
    || !verifySignature(null, Buffer.from(payload), publicKey, signature)) {
    throw new Error(`invalid ${label}`)
  }
  try {
    return JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    throw new Error(`invalid ${label}`)
  }
}

type PrincipalInput = {
    user: UserRow
    scope: PrincipalScope
    runtime: { kind: 'user' | 'project'; id: number; generation: number; runtimeId?: RuntimeId }
    purpose?: GatewayPrincipalPurpose
    now?: number
  }

// Windows V8 processes resample their own coarse system-clock baseline every minute.
// One rounded-up 15.625 ms clock tick covers an immediately delivered assertion.
const WINDOWS_PRINCIPAL_CLOCK_TICK_MS = 16

/** Signs short-lived request principals for one Gateway organization. */
export class GatewayPrincipalSigner {
  private readonly publicKey: KeyObject

  constructor(
    private readonly privateKey: KeyObject,
    private readonly organization: string,
    private readonly ttlMs: number,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('principal assertion ttl must be a positive safe integer')
    }
    this.publicKey = createPublicKey(privateKey)
  }

  /** Create one compact Ed25519 assertion bound to a runtime generation. */
  issue(input: PrincipalInput): string {
    return this.signPrincipal(input, this.ttlMs)
  }

  /**
   * Sign an ordinary event-connection assertion, capped by login expiry and 30 seconds.
   * @param input - current server-owned user, scope and runtime generation.
   * @param notAfter - existing login deadline, never extended by renewal.
   * @returns compact signed assertion whose lifetime is at most 30 seconds.
   */
  issueStream(input: Omit<PrincipalInput, 'purpose'>, notAfter = Number.MAX_SAFE_INTEGER): string {
    const now = input.now ?? Date.now()
    const lifetimeMs = Math.min(this.ttlMs, 30_000, notAfter - now)
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error('stream principal deadline has elapsed')
    return this.signPrincipal({ ...input, now }, lifetimeMs)
  }

  /** Bind a profile operation to its server-owned deadline; runtime role checks remain mandatory. */
  issuePluginManagement(input: Omit<PrincipalInput, 'purpose'>, lifetimeMs: number): string {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error('management lifetime must be a positive safe integer')
    return this.signPrincipal({ ...input, purpose: 'plugin-admin' }, lifetimeMs)
  }

  /** Bind one verified webhook delivery to its configured execution account and deadline. */
  issueWebhookDispatch(input: Omit<PrincipalInput, 'purpose'>, lifetimeMs: number): string {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error('dispatch lifetime must be a positive safe integer')
    return this.signPrincipal({ ...input, purpose: 'webhook-dispatch' }, lifetimeMs)
  }

  private signPrincipal(input: PrincipalInput, lifetimeMs: number): string {
    const now = input.now ?? Date.now()
    const issuedAt = process.platform === 'win32' ? now - WINDOWS_PRINCIPAL_CLOCK_TICK_MS : now
    const claims: GatewayPrincipalClaims = {
      version: 1,
      issuer: 'harness-gateway',
      audience: 'dsh-runtime',
      organization: this.organization,
      user: {
        id: input.user.id,
        username: input.user.username,
        displayName: input.user.displayName,
        role: input.user.role,
      },
      scope: input.scope,
      runtime: input.runtime,
      issuedAt,
      expiresAt: issuedAt + lifetimeMs,
      nonce: randomUUID(),
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    }
    return signedPayload(claims, this.privateKey)
  }

  /** Verify one assertion and return its fully validated claims. */
  verify(assertion: string, now = Date.now()): GatewayPrincipalClaims {
    const claims = principalClaims(verifiedPayload(assertion, this.publicKey, 'principal assertion'))
    if (claims.organization !== this.organization || claims.issuedAt > now || claims.expiresAt <= now) {
      throw new Error('expired or foreign principal assertion')
    }
    return claims
  }

  /** Sign one bounded assertion that a peer Gateway verified its session already. */
  issueForward(input: {
    issuerNode: string
    audienceNode: string
    user: UserRow
    selection?: { runtimeId: string | null; target: string | null }
    context?: unknown
    /** Exact request binding; without it the assertion is a bearer credential. */
    request?: { method: string; path: string; sessionHash: string }
    now?: number
  }): string {
    const now = input.now ?? Date.now()
    const issuedAt = process.platform === 'win32' ? now - WINDOWS_PRINCIPAL_CLOCK_TICK_MS : now
    const claims = {
      version: 1, issuer: 'harness-gateway', audience: 'dsh-node',
      issuerNode: input.issuerNode, audienceNode: input.audienceNode,
      organization: this.organization, user: input.user,
      ...(input.selection === undefined ? {} : { selection: input.selection }),
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.request === undefined ? {} : { request: input.request }),
      issuedAt, expiresAt: issuedAt + this.ttlMs, nonce: randomUUID(),
    }
    return signedPayload(claims, this.privateKey)
  }

  /** Issue a non-expiring capability for one lazy project-root materialization. */
  issueSessionCreation(input: {
    creatorUserId: number
    runtime: GatewaySessionCreationClaims['runtime']
    header: GatewaySessionCreationHeader
    visibility: GatewaySessionCreationClaims['visibility']
    now?: number
  }): string {
    const claims: GatewaySessionCreationClaims = {
      version: 1,
      issuer: 'harness-gateway',
      audience: 'dsh-session-creation',
      organization: this.organization,
      creatorUserId: input.creatorUserId,
      runtime: input.runtime,
      header: input.header,
      visibility: input.visibility,
      issuedAt: input.now ?? Date.now(),
      nonce: randomUUID(),
    }
    return signedPayload(claims, this.privateKey)
  }

  /** Verify one lazy project-root materialization capability. */
  verifySessionCreation(authorization: string): GatewaySessionCreationClaims {
    const claims = sessionCreationClaims(verifiedPayload(
      authorization,
      this.publicKey,
      'session creation authorization',
    ))
    if (claims.organization !== this.organization) throw new Error('invalid session creation authorization')
    return claims
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validRuntimeId(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

function principalClaims(value: unknown): GatewayPrincipalClaims {
  const claims = record(value)
  const user = record(claims?.user)
  const scope = record(claims?.scope)
  const runtime = record(claims?.runtime)
  if (claims?.version !== 1 || claims.issuer !== 'harness-gateway' || claims.audience !== 'dsh-runtime'
    || typeof claims.organization !== 'string' || claims.organization === ''
    || !positiveId(user?.id) || typeof user.username !== 'string' || user.username === ''
    || typeof user.displayName !== 'string' || (user.role !== 'admin' && user.role !== 'user')
    || (scope?.kind !== 'personal' && scope?.kind !== 'project')
    || (runtime?.kind !== 'user' && runtime?.kind !== 'project') || !positiveId(runtime.id)
    || typeof runtime.generation !== 'number' || !Number.isSafeInteger(runtime.generation) || runtime.generation < 1
    || !validRuntimeId(runtime.runtimeId)
    || typeof claims.issuedAt !== 'number' || !Number.isSafeInteger(claims.issuedAt)
    || typeof claims.expiresAt !== 'number' || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt || typeof claims.nonce !== 'string' || claims.nonce === '') {
    throw new Error('invalid principal assertion')
  }
  if (claims.purpose !== undefined && claims.purpose !== 'archive-read' && claims.purpose !== 'document-admin'
    && claims.purpose !== 'terminal-admin' && claims.purpose !== 'plugin-admin' && claims.purpose !== 'webhook-dispatch') {
    throw new Error('invalid principal assertion')
  }
  // Webhook dispatch carries the endpoint's configured execution account, which
  // is deliberately not an administrator; every other purpose is an admin power.
  if (claims.purpose !== undefined && claims.purpose !== 'webhook-dispatch' && user.role !== 'admin') {
    throw new Error('invalid principal assertion')
  }
  if (scope.kind === 'project' && (!positiveId(scope.projectId) || typeof scope.projectName !== 'string'
    || scope.projectName === '' || (scope.mode !== 'ro' && scope.mode !== 'rw')
    || (scope.canManage !== undefined && typeof scope.canManage !== 'boolean'))) {
    throw new Error('invalid principal assertion')
  }
  return value as GatewayPrincipalClaims
}

function sessionCreationHeader(value: unknown): GatewaySessionCreationHeader {
  const header = record(value)
  if (typeof header?.id !== 'string' || header.id === ''
    || typeof header.version !== 'number' || !Number.isSafeInteger(header.version) || header.version < 0
    || typeof header.createdAt !== 'number' || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0
    || (header.cwd !== undefined && typeof header.cwd !== 'string')
    || (header.parentSession !== undefined && typeof header.parentSession !== 'string')
    || (header.seedLength !== undefined
      && (typeof header.seedLength !== 'number' || !Number.isSafeInteger(header.seedLength) || header.seedLength < 0))
    || (header.origin !== undefined && header.origin !== 'subagent')
    || (header.delegationDepth !== undefined
      && (typeof header.delegationDepth !== 'number'
        || !Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0))
    || (header.agentPreset !== undefined && typeof header.agentPreset !== 'string')
    || (header.draft !== undefined && typeof header.draft !== 'boolean')
    || (header.sshTarget !== undefined && !positiveId(header.sshTarget))) {
    throw new Error('invalid session creation authorization')
  }
  return value as GatewaySessionCreationHeader
}

function sessionCreationClaims(value: unknown): GatewaySessionCreationClaims {
  const claims = record(value)
  const runtime = record(claims?.runtime)
  if (claims?.version !== 1 || claims.issuer !== 'harness-gateway'
    || claims.audience !== 'dsh-session-creation'
    || typeof claims.organization !== 'string' || claims.organization === ''
    || !positiveId(claims.creatorUserId) || runtime?.kind !== 'project'
    || !positiveId(runtime.id) || !positiveId(runtime.generation)
    || !validRuntimeId(runtime.runtimeId)
    || (claims.visibility !== 'project' && claims.visibility !== 'private')
    || typeof claims.issuedAt !== 'number' || !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt < 0
    || typeof claims.nonce !== 'string' || claims.nonce === '') {
    throw new Error('invalid session creation authorization')
  }
  sessionCreationHeader(claims.header)
  return value as GatewaySessionCreationClaims
}

export interface PrincipalKeys {
  signer: GatewayPrincipalSigner
  publicKeyPem: string
}

function isAlreadyPresent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/** Load or atomically create the Gateway's persistent Ed25519 private key. */
export function loadPrincipalKeys(keyDir: string, organization: string, ttlMs: number): PrincipalKeys {
  const privatePath = join(keyDir, 'principal-private.pem')
  const publicPath = join(keyDir, 'principal-public.pem')
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  chmodSync(keyDir, 0o700)
  if (!existsSync(privatePath)) {
    const pair = generateKeyPairSync('ed25519')
    const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const suffix = `${String(process.pid)}.${String(Date.now())}.tmp`
    const privateTemp = `${privatePath}.${suffix}`
    writeFileSync(privateTemp, privatePem, { mode: 0o600, flag: 'wx' })
    try {
      // link(2) publishes the complete temp file without replacing a key
      // another Gateway process may have won concurrently.
      linkSync(privateTemp, privatePath)
    } catch (error: unknown) {
      if (!isAlreadyPresent(error)) throw error
    } finally {
      unlinkSync(privateTemp)
    }
  }
  chmodSync(privatePath, 0o600)
  const privateKey = createPrivateKey(readFileSync(privatePath, 'utf8'))
  const publicKeyPem = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString()
  // Older development trees wrote a second public-key file. It is derived
  // data and cannot participate in an atomic key identity, so remove it.
  if (existsSync(publicPath)) unlinkSync(publicPath)
  return {
    signer: new GatewayPrincipalSigner(privateKey, organization, ttlMs),
    publicKeyPem,
  }
}
