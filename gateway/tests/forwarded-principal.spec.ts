import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { forwardIssuerOf, verifyGatewayForward } from '../src/forwarded-principal.ts'
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
    // A PEM string resolves the same public key.
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    expect(verifyGatewayForward(assertion, pem, input)?.user.id).toBe(7)
    expect(createPublicKey(privateKey).equals(publicKey)).toBe(true)
  })
})
