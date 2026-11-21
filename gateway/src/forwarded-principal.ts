import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import type { UserRow } from './auth.ts'
import type { RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'
import { nodeUuidSchema } from './node-access.ts'
import type { NodePrincipalDirectory } from './postgres/node-principal-directory.ts'
import { verifiedPayload } from './principal.ts'

export const FORWARDED_PRINCIPAL_HEADER = 'x-dsh-gateway-forward'

const personalHistoryAdmissionSchema = z.object({
  generation: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  launchStamp: z.string().max(256).nullable(),
  startedAt: z.number().int().nonnegative(),
  accessRevision: z.string().regex(/^[0-9]{1,20}$/u),
  expiresAt: z.number().int().positive(),
}).strict()

/** Exact supervised generation and current revision approved by the primary for personal history. */
export type PersonalHistoryAdmission = z.infer<typeof personalHistoryAdmissionSchema>

/**
 * Claims a forwarding Gateway already proved for one request aimed at
 * `audienceNode`: session validity and the authenticated account row. The
 * destination verifies the issuer's published principal key and answers from
 * `user` directly, skipping its own session renewal and authority snapshot;
 * every later data query still encodes its own permission predicates.
 */
export interface GatewayForwardClaims {
  version: 1
  issuer: 'harness-gateway'
  audience: 'dsh-node'
  issuerNode: RuntimeNodeId
  audienceNode: RuntimeNodeId
  organization: string
  user: UserRow
  /**
   * The request selectors this assertion was issued for; a destination only
   * trusts `context` when its own parsed selectors equal these exactly.
   */
  selection?: { runtimeId: RuntimeId | null; target: string | null }
  /**
   * The authorized environment the issuer's placement already produced. Scope
   * and runtime storage stay node-local on the destination, so only the
   * placement result travels; the destination adopts it as a checked
   * `RuntimePlacement` when the selector binding matches exactly.
   */
  context?: {
    environment: { id: RuntimeId; nodeId: RuntimeNodeId; nodeName?: string }
    personalHistory?: PersonalHistoryAdmission
  }
  /**
   * The exact request this assertion was issued for. Without it the assertion
   * is a bearer credential: any holder could reuse it on any gateway-local
   * path within its TTL. The destination accepts the claims only when the
   * arrived method, pathname and session token hash all match, so a captured
   * or replayed assertion is worthless without the forwarded session.
   */
  request?: { method: string; path: string; sessionHash: string }
  issuedAt: number
  expiresAt: number
  nonce: string
}

/** A signature verified with previously published key bytes pending current issuer and Session admission. */
export interface GatewayForwardSessionCandidate {
  readonly claims: GatewayForwardClaims
  readonly issuerPublicKey: string
  /** @returns whether the nonce was consumed while the assertion was still live. */
  consume(): boolean
}

/** Verification functions and replay state owned by one Gateway process. */
interface ForwardAuthority {
  forwardedSessionPrincipal(assertion: string): GatewayForwardSessionCandidate | null
  forwardedPrincipal(assertion: string): Promise<GatewayForwardClaims | null>
}

/**
 * Verify forwarded browser identities against the current node's audience and issuer directory.
 * @param directory - published issuer keys and their live authority.
 * @param audience - exact receiving node and organization.
 * @param ttlMs - maximum lifetime retained by the process-local nonce ledger.
 * @returns verification callbacks for the ordinary and retained Session admission paths.
 */
export function createGatewayForwardAuthority(directory: NodePrincipalDirectory, audience: {
  audienceNode: RuntimeNodeId; organization: string
}, ttlMs: number): ForwardAuthority {
  const nonces = new Map<string, number>()
  const consume = (claims: GatewayForwardClaims): boolean => {
    const now = Date.now()
    if (claims.expiresAt <= now) return false
    for (const [nonce, expiry] of nonces) if (expiry <= now) nonces.delete(nonce)
    if (nonces.has(claims.nonce)) return false
    if (nonces.size >= 4096) nonces.clear()
    nonces.set(claims.nonce, Math.min(claims.expiresAt, now + ttlMs))
    return true
  }
  return {
    forwardedSessionPrincipal(assertion) {
      const issuer = forwardIssuerOf(assertion)
      const issuerPublicKey = issuer === null ? null : directory.publishedKeyCandidate(issuer)
      if (issuerPublicKey === null) return null
      const claims = verifyGatewayForward(assertion, issuerPublicKey, audience)
      return claims === null ? null : { claims, issuerPublicKey, consume: () => consume(claims) }
    },
    async forwardedPrincipal(assertion) {
      try {
        const issuer = forwardIssuerOf(assertion)
        const key = issuer === null ? null : await directory.issuerKey(issuer)
        const claims = key === null ? null : verifyGatewayForward(assertion, key, audience)
        return claims !== null && consume(claims) ? claims : null
      } catch {
        // An unavailable issuer directory leaves the request to regular browser authentication.
        return null
      }
    },
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function forwardClaims(value: unknown): GatewayForwardClaims {
  const claims = record(value)
  const user = record(claims?.user)
  if (claims?.version !== 1 || claims.issuer !== 'harness-gateway' || claims.audience !== 'dsh-node'
    || typeof claims.issuerNode !== 'string' || claims.issuerNode === ''
    || typeof claims.audienceNode !== 'string' || claims.audienceNode === ''
    || typeof claims.organization !== 'string' || claims.organization === ''
    || user === undefined || !Number.isSafeInteger(user.id) || (user.id as number) <= 0
    || typeof user.username !== 'string' || user.username === ''
    || typeof user.displayName !== 'string'
    || (user.role !== 'admin' && user.role !== 'user')
    || (user.status !== 'active' && user.status !== 'disabled')
    || typeof user.homePath !== 'string'
    || (user.homeNodeId !== undefined && typeof user.homeNodeId !== 'string')
    || typeof user.mustChangePassword !== 'boolean'
    || typeof user.autoReviewEligible !== 'boolean'
    || typeof claims.issuedAt !== 'number' || !Number.isSafeInteger(claims.issuedAt)
    || typeof claims.expiresAt !== 'number' || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt
    || typeof claims.nonce !== 'string' || claims.nonce === '') {
    throw new Error('invalid forwarded principal claims')
  }
  if (claims.selection !== undefined) {
    const selection = record(claims.selection)
    if (selection === undefined
      || (selection.runtimeId !== null && typeof selection.runtimeId !== 'string')
      || (selection.target !== null && typeof selection.target !== 'string')) {
      throw new Error('invalid forwarded principal claims')
    }
  }
  if (claims.context !== undefined) {
    const context = record(claims.context), environment = record(context?.environment)
    if (context === undefined || environment === undefined || typeof environment.id !== 'string'
      || typeof environment.nodeId !== 'string'
      || (environment.nodeName !== undefined && typeof environment.nodeName !== 'string')
      || context.personalHistory !== undefined && !personalHistoryAdmissionSchema.safeParse(context.personalHistory).success) {
      throw new Error('invalid forwarded principal claims')
    }
  }
  if (claims.request !== undefined) {
    const request = record(claims.request)
    if (request === undefined || typeof request.method !== 'string'
      || typeof request.path !== 'string' || typeof request.sessionHash !== 'string') {
      throw new Error('invalid forwarded principal claims')
    }
  }
  return value as GatewayForwardClaims
}

/**
 * Read the unverified `issuerNode` so the caller can resolve its published key;
 * the value only becomes trustworthy after `verifyGatewayForward` succeeds.
 * Anything that is not a node id never reaches the directory query — callers
 * treat the assertion as absent, keeping malformed issuers on the ordinary
 * session path instead of surfacing a database type error.
 */
export function forwardIssuerOf(assertion: string): RuntimeNodeId | null {
  try {
    const payload = assertion.split('.')[0]
    if (payload === undefined || payload === '') return null
    const claims = record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return typeof claims?.issuerNode === 'string' && nodeUuidSchema.safeParse(claims.issuerNode).success
      ? claims.issuerNode as RuntimeNodeId : null
  } catch {
    return null
  }
}

/**
 * Verify one forwarded-request assertion against the issuer's published key.
 * Returns claims when the signature, this node's exact audience, the shared
 * organization and the liveness window all hold; null otherwise, letting the
 * caller fall back to ordinary session validation.
 */
export function verifyGatewayForward(assertion: string, issuerKey: KeyObject | string, input: {
  audienceNode: RuntimeNodeId
  organization: string
  now?: number
}): GatewayForwardClaims | null {
  try {
    const publicKey = typeof issuerKey === 'string' ? createPublicKey(issuerKey) : issuerKey
    const claims = forwardClaims(verifiedPayload(assertion, publicKey, 'forwarded principal'))
    const now = input.now ?? Date.now()
    if (claims.audienceNode !== input.audienceNode || claims.organization !== input.organization
      || claims.issuedAt > now || claims.expiresAt <= now) return null
    return claims
  } catch {
    return null
  }
}

/**
 * Bind verified claims to the arriving request. The assertion was issued for
 * exactly one method+pathname and one validated session: any in-flight rewrite
 * of the request line, or reuse without the forwarded session cookie, makes
 * the match fail and the caller falls back to ordinary session validation.
 * @param claims - verified assertions from verifyGatewayForward.
 * @param input - arrived request line and session cookie token (undefined when absent).
 * @returns whether the claims may stand in for session validation on this request.
 */
export function forwardRequestMatches(claims: GatewayForwardClaims, input: {
  method: string | undefined
  path: string
  sessionToken: string | undefined
}): boolean {
  const request = claims.request
  if (input.sessionToken === undefined || request === undefined) return false
  return request.method === input.method && request.path === input.path
    && createHash('sha256').update(input.sessionToken).digest('hex') === request.sessionHash
}
