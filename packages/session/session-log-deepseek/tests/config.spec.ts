import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('session-log upload configuration', () => {
  it('defaults upload off and honors explicit overrides', () => {
    expect(Config({}).enabled.get()).toBe(false)
    expect(Config({ enabled: true }).enabled.get()).toBe(true)
    expect(Config({ enabled: false }).enabled.get()).toBe(false)
  })

  it('defaults the endpoint allowlist, kill switch, audit, and size fields', () => {
    const config = Config({})
    expect(config.allowedEndpoints).toEqual([])
    expect(config.killSwitchEnv).toBe('COHARNESS_DISABLE_SESSION_LOG_UPLOAD')
    expect(config.audit).toBe(true)
    expect(config.maxBytes).toBe(8 * 1024 * 1024)
  })

  it('accepts a positive integer maxBytes and rejects other values', () => {
    expect(Config({ maxBytes: 1 }).maxBytes).toBe(1)
    for (const maxBytes of [0, -1, 1.5]) expect(() => Config({ maxBytes })).toThrow()
  })
})
