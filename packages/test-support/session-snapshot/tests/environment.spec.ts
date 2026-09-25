import { describe, expect, it } from 'vitest'
import { snapshotChildEnvironment } from '../src/environment.ts'

describe('snapshot child environment', () => {
  const parent = { PATH: '/runtime/bin', DEEPSEEK_API_KEY: 'ambient', AZURE_OPENAI_API_KEY: 'ambient', ANTHROPIC_API_KEY: 'ambient', github_token: 'ambient' }
  it.each(['replay', 'refresh'])('%s excludes ambient credentials and preserves controlled fixture values', mode => {
    expect(snapshotChildEnvironment(mode, { DSH_HOME: '/private/home', FIXTURE_TOKEN: 'controlled' }, parent))
      .toEqual({ PATH: '/runtime/bin', DSH_HOME: '/private/home', FIXTURE_TOKEN: 'controlled' })
    expect(parent.DEEPSEEK_API_KEY).toBe('ambient')
  })
  it.each(['record', undefined])('explicit live launch %s retains provider configuration', mode => {
    expect(snapshotChildEnvironment(mode, {}, parent)).toEqual(parent)
  })
  it('refuses an unrecognized mode instead of admitting live credentials', () => {
    expect(() => snapshotChildEnvironment('refreshh', {}, parent)).toThrow('invalid snapshot mode')
  })
})
