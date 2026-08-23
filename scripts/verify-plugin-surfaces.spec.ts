import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectPluginSurfaceFacts,
  collectPluginSurfaceViolations,
  IMMEDIATE_CLIENT_ALLOWLIST,
} from './verify-plugin-surfaces.ts'

const ROOT = resolve(import.meta.dirname, '..')

describe('verify-plugin-surfaces', () => {
  it('reports the current runtime and browser partition', () => {
    const facts = collectPluginSurfaceFacts(ROOT)
    expect(facts.packageCount).toBeGreaterThan(200)
    expect(facts.bundles).toContain('@deepseek-ai/dsh-web-app')
    expect(facts.externalPluginBundles).toEqual([
      '@deepseek-ai/dsh-directory-guard',
      '@deepseek-ai/dsh-model-governance',
    ])
    expect(facts.dynamicClientPackages.length).toBe(46)
    expect(facts.dynamicClientPackages).toContain('@deepseek-ai/dsh-client-ui-cordis')
    expect(facts.dynamicClientPackages).toContain('@deepseek-ai/dsh-cordis-client-runner')
    expect(facts.dynamicClientPackages).toContain('@deepseek-ai/dsh-api-gateway')
    expect(facts.dynamicClientPackages).toContain('@deepseek-ai/dsh-session-log-export')
    expect(facts.staticClientPackages).toEqual([
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-web',
    ])
    expect(facts.immediateClientPackages.every(name => IMMEDIATE_CLIENT_ALLOWLIST.has(name))).toBe(true)
    expect(facts.baseRowCount).toBeGreaterThan(50)
  })

  it('accepts the production HMR switch and all Bundle patch targets', () => {
    const facts = collectPluginSurfaceFacts(ROOT)
    expect(collectPluginSurfaceViolations(ROOT, facts)).toEqual([])
  })
})
