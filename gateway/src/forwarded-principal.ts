import { createPublicKey, type KeyObject } from 'node:crypto'
import type { UserRow } from './auth.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import { verifiedPayload } from './principal.ts'

export const FORWARDED_PRINCIPAL_HEADER = 'x-dsh-gateway-forward'

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
  issuedAt: number
  expiresAt: number
  nonce: string
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
    || typeof claims.issuedAt !== 'number' || typeof claims.expiresAt !== 'number'
    || claims.expiresAt <= claims.issuedAt
    || typeof claims.nonce !== 'string' || claims.nonce === '') {
    throw new Error('invalid forwarded principal claims')
  }
  return value as GatewayForwardClaims
}

/**
 * Read the unverified `issuerNode` so the caller can resolve its published key;
 * the value only becomes trustworthy after `verifyGatewayForward` succeeds.
 */
export function forwardIssuerOf(assertion: string): RuntimeNodeId | null {
  try {
    const payload = assertion.split('.')[0]
    if (payload === undefined || payload === '') return null
    const claims = record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return typeof claims?.issuerNode === 'string' && claims.issuerNode !== ''
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
