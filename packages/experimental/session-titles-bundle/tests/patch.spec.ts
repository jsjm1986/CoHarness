/**
 * The experimental session-titles bundle disables the shipped first-prompt
 * provider row and inserts the all-prompts provider under its own id, so
 * deselecting the bundle restores the shipped composition.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))

interface Manifest {
  name?: string
  icon?: string
  private?: boolean
  publishConfig?: { access?: string }
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

describe('experimental session-titles bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('publishes as an experimental bundle with plugin-manager display metadata', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-experimental-session-titles-bundle')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // Each touched row names a package the bundle depends on, so the rows resolve from the bundle.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-session-title-all-prompts-llm',
    ])
  })

  it('disables the shipped session-title-llm row and inserts its replacement', () => {
    const parsed = yaml.load(readFileSync(resolve(root, './cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([
      { id: 'session-title-llm', disabled: true },
      { insert: [
        {
          id: 'optional-session-title-all-prompts',
          name: '@deepseek-ai/dsh-session-title-all-prompts-llm',
          config: {
            targetWords: 5,
            targetCjkCharacters: 10,
            maxInputBytes: 4096,
            maxOutputTokens: 64,
            timeoutMs: 60000,
          },
        },
      ] },
    ])
  })
})
