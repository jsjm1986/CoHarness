import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { composeProfilePatches, composeRows, resolveShippedPresetPatch } from '../src/profile-boot.ts'

function row(config: unknown): EntryOptions {
  return { id: 'agent-presets', config } as EntryOptions
}

describe('launcher-derived shipped agent-preset root', () => {
  it('prepends the shipped root while retaining configured roots and fields', () => {
    const configured = { path: '/tmp/custom-presets', trust: 'user' }
    const patch = resolveShippedPresetPatch(composeRows([[
      { insert: [row({ default: 'custom', includeUserRoot: false, roots: [configured] })] },
    ]]))
    expect(patch).toMatchObject({
      id: 'agent-presets',
      config: {
        default: 'custom',
        includeUserRoot: false,
        roots: [
          { trust: 'system' },
          configured,
        ],
      },
    })
    const shipped = (patch?.config as { roots: { path: string }[] }).roots[0]?.path
    expect(shipped).toContain('config/agent-presets')
  })

  it('returns no derived patch when the composition has no roster', () => {
    expect(resolveShippedPresetPatch(new Map())).toBeUndefined()
    expect(composeProfilePatches([[{ id: 'other', disabled: true }]])).toEqual([
      { id: 'other', disabled: true },
    ])
  })

  it('fails loudly when roots are not a literal array', () => {
    expect(() => resolveShippedPresetPatch(composeRows([[{ insert: [row({ roots: '/tmp/not-an-array' })] }]])))
      .toThrow('config.roots must be a literal array')
  })
})
