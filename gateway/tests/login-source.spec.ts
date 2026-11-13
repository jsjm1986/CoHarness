import { describe, expect, it } from 'vitest'
import { forwardedClientAddress, loginSource, trustedProxyList, validTrustedProxy } from '../src/login-source.ts'

describe('loginSource', () => {
  it('buckets IPv4 per address and IPv6 per /64', () => {
    expect(loginSource('::ffff:203.0.113.7')).toEqual({ address: '203.0.113.7', bucket: '203.0.113.7/32', distinguishable: true })
    expect(loginSource('2001:DB8:0:1:2::3')).toEqual({ address: '2001:db8:0:1:2::3', bucket: '2001:db8:0:1::/64', distinguishable: true })
    expect(loginSource('2001:db8::1').bucket).toBe('2001:db8:0:0::/64')
    expect(loginSource('fe80::1%eth0').bucket).toBe('fe80:0:0:0::/64')
  })

  it('marks missing and loopback sources undistinguishable', () => {
    expect(loginSource('')).toEqual({ address: null, bucket: null, distinguishable: false })
    expect(loginSource('not-an-ip')).toEqual({ address: null, bucket: null, distinguishable: false })
    expect(loginSource('127.0.0.1').distinguishable).toBe(false)
    expect(loginSource('127.8.9.10').distinguishable).toBe(false)
    expect(loginSource('::1')).toMatchObject({ bucket: '0:0:0:0::/64', distinguishable: false })
    expect(loginSource('::ffff:127.0.0.1').distinguishable).toBe(false)
  })
})

describe('forwardedClientAddress', () => {
  const proxies = trustedProxyList(['127.0.0.1', '::1', '10.0.0.0/8'])

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(forwardedClientAddress('198.51.100.9', '203.0.113.7', proxies)).toBe('198.51.100.9')
  })

  it('selects the rightmost untrusted hop behind trusted proxies', () => {
    expect(forwardedClientAddress('::ffff:127.0.0.1', '1.1.1.1, 203.0.113.7', proxies)).toBe('203.0.113.7')
    expect(forwardedClientAddress('::1', ['1.1.1.1', '203.0.113.7, 10.1.2.3'], proxies)).toBe('203.0.113.7')
  })

  it('keeps the last trusted hop when the chain is absent, exhausted, or malformed', () => {
    expect(forwardedClientAddress('127.0.0.1', undefined, proxies)).toBe('127.0.0.1')
    expect(forwardedClientAddress('127.0.0.1', '10.0.0.5', proxies)).toBe('10.0.0.5')
    expect(forwardedClientAddress('127.0.0.1', '203.0.113.7, unknown', proxies)).toBe('127.0.0.1')
    expect(forwardedClientAddress('127.0.0.1', '', proxies)).toBe('127.0.0.1')
  })

  it('trusts nothing with an empty proxy list', () => {
    expect(forwardedClientAddress('127.0.0.1', '203.0.113.7', trustedProxyList([]))).toBe('127.0.0.1')
  })
})

describe('validTrustedProxy', () => {
  it('accepts addresses and in-family CIDR ranges only', () => {
    for (const entry of ['127.0.0.1', '::1', '10.0.0.0/8', '2001:db8::/32', '0.0.0.0/0']) expect(validTrustedProxy(entry)).toBe(true)
    for (const entry of ['localhost', '10.0.0.0/33', '::/129', '10.0.0.0/', '10.0.0.0/8/1', '10.0.0.0/x']) expect(validTrustedProxy(entry)).toBe(false)
  })
})
