import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TunnelCredentialCipher } from '../src/postgres/tunnel-access-service.ts'

describe('TunnelCredentialCipher', () => {
  it('round-trips UTF-8 secrets with a fresh nonce for each ciphertext', () => {
    const cipher = new TunnelCredentialCipher(randomBytes(32))
    const secret = 'synthetic tunnel token / 测试'
    const first = cipher.encrypt('organization', 'node', 'api-token', secret)
    const second = cipher.encrypt('organization', 'node', 'api-token', secret)
    expect(first.equals(second)).toBe(false)
    expect(first.includes(Buffer.from(secret))).toBe(false)
    expect(cipher.decrypt('organization', 'node', 'api-token', first)).toBe(secret)
    expect(cipher.decrypt('organization', 'node', 'api-token', second)).toBe(secret)
  })

  it.each([
    ['nonce', 0], ['authentication tag', 12], ['ciphertext', 28],
  ] as const)('rejects a changed %s', (_part, offset) => {
    const cipher = new TunnelCredentialCipher(randomBytes(32))
    const packed = cipher.encrypt('organization', 'node', 'run-token', 'synthetic-token')
    packed[offset] = packed[offset]! ^ 1
    expect(() => cipher.decrypt('organization', 'node', 'run-token', packed)).toThrow()
  })

  it.each([
    ['other-organization', 'node', 'run-token'],
    ['organization', 'other-node', 'run-token'],
    ['organization', 'node', 'api-token'],
  ])('rejects credentials borrowed by %s / %s / %s', (organization, node, field) => {
    const cipher = new TunnelCredentialCipher(randomBytes(32))
    const packed = cipher.encrypt('organization', 'node', 'run-token', 'synthetic-token')
    expect(() => cipher.decrypt(organization, node, field, packed)).toThrow()
  })

  it('requires the original key and rejects truncated persisted bytes', () => {
    const cipher = new TunnelCredentialCipher(randomBytes(32))
    const packed = cipher.encrypt('organization', 'node', 'run-token', 'synthetic-token')
    const other = new TunnelCredentialCipher(randomBytes(32))
    expect(() => other.decrypt('organization', 'node', 'run-token', packed)).toThrow()
    expect(() => cipher.decrypt('organization', 'node', 'run-token', packed.subarray(0, 28)))
      .toThrow('tunnel credential ciphertext is truncated')
  })
})
