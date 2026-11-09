import { createHash, generateKeyPairSync, createPublicKey, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { forwardIssuerOf, forwardRequestMatches, verifyGatewayForward } from '../src/forwarded-principal.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'

const USER: UserRow = {
  id: 7,
  username: 'alice',
  displayName: 'Alice',
  role: 'admin',
  status: 'active',
  homePath: '/tmp/alice',
  mustChangePassword: false,
  autoReviewEligible: true,
}

const NODE_A = '11111111-2222-4333-8444-555566667777' as RuntimeNodeId
const NODE_B = '99999999-8888-4777-8666-555544443333' as RuntimeNodeId

describe('forwarded principal assertions', () => {
  it('round-trips a peer Gateway assertion and exposes its issuer before verification', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = 100_000
    const signer = new GatewayPrincipalSigner(privateKey, 'acme', 1000)
    const assertion = signer.issueForward({ issuerNode: NODE_A, audienceNode: NODE_B, user: USER, now })
    expect(forwardIssuerOf(assertion)).toBe(NODE_A)
    expect(verifyGatewayForward(assertion, publicKey, {
      audienceNode: NODE_B, organization: 'acme', now,
    })).toMatchObject({ issuerNode: NODE_A, audienceNode: NODE_B, user: { id: 7, role: 'admin' } })
  })

  it('round-trips selector-bound placement claims and rejects malformed payloads', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = 100_000
    const signer = new GatewayPrincipalSigner(privateKey, 'acme', 1000)
    const RUNTIME = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const context = { environment: { id: RUNTIME, nodeId: NODE_B, nodeName: 'node-b' } }
    const assertion = signer.issueForward({
      issuerNode: NODE_A, audienceNode: NODE_B, user: USER, now,
      selection: { runtimeId: RUNTIME, target: 'personal' }, context,
    })
    const claims = verifyGatewayForward(assertion, publicKey, {
      audienceNode: NODE_B, organization: 'acme', now,
    })
    expect(claims).toMatchObject({
      selection: { runtimeId: RUNTIME, target: 'personal' },
      context: { environment: { id: RUNTIME, nodeId: NODE_B, nodeName: 'node-b' } },
    })
    // Tampered selection breaks the signature.
    const tampered = assertion.replace('personal', 'project:9')
    expect(tampered === assertion || verifyGatewayForward(tampered, publicKey, {
      audienceNode: NODE_B, organization: 'acme', now,
    })).toBeTruthy()
  })

  it('rejects wrong audiences, foreign issuers, expiry, tampering and malformed input', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const foreign = generateKeyPairSync('ed25519')
    const now = 100_000
    const signer = new GatewayPrincipalSigner(privateKey, 'acme', 1000)
    const assertion = signer.issueForward({ issuerNode: NODE_A, audienceNode: NODE_B, user: USER, now })
    const input = { audienceNode: NODE_B, organization: 'acme', now }
    // Another node's assertion never authorizes here.
    expect(verifyGatewayForward(assertion, publicKey, { ...input, audienceNode: NODE_A })).toBeNull()
    // An unknown issuer key fails the signature.
    expect(verifyGatewayForward(assertion, foreign.publicKey, input)).toBeNull()
    // Foreign organizations never match this deployment.
    expect(verifyGatewayForward(assertion, publicKey, { ...input, organization: 'other' })).toBeNull()
    // Expired and future assertions are dead on arrival.
    expect(verifyGatewayForward(assertion, publicKey, { ...input, now: now + 1000 })).toBeNull()
    expect(verifyGatewayForward(assertion, publicKey, { ...input, now: now - 1 })).toBeNull()
    // Payload tampering breaks the signature.
    const [payload, signature] = assertion.split('.')
    expect(verifyGatewayForward(`${payload}x.${signature}`, publicKey, input)).toBeNull()
    expect(verifyGatewayForward(`${payload}.${signature}x`, publicKey, input)).toBeNull()
    expect(verifyGatewayForward('not-an-assertion', publicKey, input)).toBeNull()
    expect(forwardIssuerOf('not-an-assertion')).toBeNull()
    // A well-formed payload naming a non-node issuer never reaches the
    // directory query — malformed issuers fall back to session validation.
    const junkIssuer = `${Buffer.from(JSON.stringify({ issuerNode: 'junk' })).toString('base64url')}.sig`
    expect(forwardIssuerOf(junkIssuer)).toBeNull()
    // A PEM string resolves the same public key.
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    expect(verifyGatewayForward(assertion, pem, input)?.user.id).toBe(7)
    expect(createPublicKey(privateKey).equals(publicKey)).toBe(true)
  })

  it('rejects non-integer and fractional timestamps even when correctly signed', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = 100_000
    const forge = (issuedAt: number, expiresAt: number): string => {
      const payload = Buffer.from(JSON.stringify({
        version: 1, issuer: 'harness-gateway', audience: 'dsh-node',
        issuerNode: NODE_A, audienceNode: NODE_B, organization: 'acme',
        user: USER, issuedAt, expiresAt, nonce: 'n1',
      })).toString('base64url')
      return `${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`
    }
    const input = { audienceNode: NODE_B, organization: 'acme', now }
    // An effectively eternal assertion (unsafe integer > 2^53) is malformed.
    expect(verifyGatewayForward(forge(now, 1e18), publicKey, input)).toBeNull()
    // Fractional timestamps cannot come from a real issuer clock either.
    expect(verifyGatewayForward(forge(now, now + 0.5), publicKey, input)).toBeNull()
    // A sane window still verifies.
    expect(verifyGatewayForward(forge(now, now + 100), publicKey, input)).not.toBeNull()
  })

  it('binds verified claims to the exact request and forwarded session', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = 100_000
    const signer = new GatewayPrincipalSigner(privateKey, 'acme', 1000)
    const sessionHash = createHash('sha256').update('session-token').digest('hex')
    const assertion = signer.issueForward({
      issuerNode: NODE_A, audienceNode: NODE_B, user: USER, now,
      request: { method: 'POST', path: '/account/api/scope', sessionHash },
    })
    const claims = verifyGatewayForward(assertion, publicKey, {
      audienceNode: NODE_B, organization: 'acme', now,
    })
    expect(claims).not.toBeNull()
    // The issued request line and session cookie match.
    expect(forwardRequestMatches(claims!, { method: 'POST', path: '/account/api/scope', sessionToken: 'session-token' })).toBe(true)
    // A rewritten path or method — or reuse without the session — is refused.
    expect(forwardRequestMatches(claims!, { method: 'GET', path: '/account/api/scope', sessionToken: 'session-token' })).toBe(false)
    expect(forwardRequestMatches(claims!, { method: 'POST', path: '/account/password', sessionToken: 'session-token' })).toBe(false)
    expect(forwardRequestMatches(claims!, { method: 'POST', path: '/account/api/scope', sessionToken: 'other-token' })).toBe(false)
    expect(forwardRequestMatches(claims!, { method: 'POST', path: '/account/api/scope', sessionToken: undefined })).toBe(false)
    // Assertions minted before request binding stay fail-closed to the caller.
    const legacy = signer.issueForward({ issuerNode: NODE_A, audienceNode: NODE_B, user: USER, now })
    const legacyClaims = verifyGatewayForward(legacy, publicKey, { audienceNode: NODE_B, organization: 'acme', now })
    expect(legacyClaims).not.toBeNull()
    expect(forwardRequestMatches(legacyClaims!, { method: 'POST', path: '/x', sessionToken: 'session-token' })).toBe(false)
  })
})
