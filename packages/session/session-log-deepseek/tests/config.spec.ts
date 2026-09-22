import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('session-log upload configuration', () => {
  it('defaults upload off and honors explicit overrides', () => {
    expect(Config({}).enabled).toBe(false)
    expect(Config({ enabled: true }).enabled).toBe(true)
    expect(Config({ enabled: false }).enabled).toBe(false)
  })

  it('defaults the endpoint allowlist, kill switch, and audit fields', () => {
    const config = Config({})
    expect(config.allowedEndpoints).toEqual([])
    expect(config.killSwitchEnv).toBe('COHARNESS_DISABLE_SESSION_LOG_UPLOAD')
    expect(config.audit).toBe(true)
  })
})
