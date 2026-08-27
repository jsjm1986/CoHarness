/** Authenticated readiness challenge shared by the Gateway launcher and runtime probe. */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Private runtime endpoint used only by the Gateway readiness probe. */
export const RUNTIME_READINESS_PATH = '/api/internal/gateway/readiness'
/** Header carrying the one-time readiness nonce. */
export const RUNTIME_READINESS_NONCE_HEADER = 'x-dsh-gateway-readiness-nonce'
/** Header carrying the Gateway's challenge proof. */
export const RUNTIME_READINESS_REQUEST_HEADER = 'x-dsh-gateway-readiness-request'
/** Header carrying the runtime's response proof. */
export const RUNTIME_READINESS_RESPONSE_HEADER = 'x-dsh-gateway-readiness-response'

export interface RuntimeReadinessIdentity {
  readonly kind: 'user' | 'project'
  readonly id: number
  readonly generation: number
}

function material(kind: 'request' | 'response', nonce: string, identity: RuntimeReadinessIdentity): string {
  return `dsh-gateway-readiness-v1\u0000${kind}\u0000${nonce}\u0000${identity.kind}\u0000${String(identity.id)}\u0000${String(identity.generation)}`
}

/** Create the proof a Gateway sends with a readiness challenge. */
export function runtimeReadinessRequestProof(
  token: string,
  nonce: string,
  identity: RuntimeReadinessIdentity,
): string {
  return createHmac('sha256', token).update(material('request', nonce, identity)).digest('base64url')
}

/** Create the proof a genuine runtime returns after accepting a challenge. */
export function runtimeReadinessResponseProof(
  token: string,
  nonce: string,
  identity: RuntimeReadinessIdentity,
): string {
  return createHmac('sha256', token).update(material('response', nonce, identity)).digest('base64url')
}

/** Constant-time comparison for a runtime response proof. */
export function sameRuntimeReadinessProof(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false
  const left = Buffer.from(expected, 'base64url')
  const right = Buffer.from(actual, 'base64url')
  return left.length === right.length && timingSafeEqual(left, right)
}
