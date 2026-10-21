/**
 * The experimental reasoning-translation bundle inserts the Translator service and the
 * client UI contribution under their own ids, so deselecting the bundle restores the
 * shipped composition without machine translation.
 */

import { existsSync, readFileSync } from 'node:fs'
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

describe('experimental cot-translation bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('publishes as an experimental bundle with plugin-manager display metadata', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-experimental-cot-translation-bundle')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // Each inserted row names a package the bundle depends on, so the rows resolve from the bundle.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-experimental-client-ui-cot-translation',
      '@deepseek-ai/dsh-experimental-translator',
    ])
    expect(existsSync(resolve(root, 'icon.svg'))).toBe(true)
    for (const locale of ['en.json', 'zh.json']) {
      const parsed = JSON.parse(readFileSync(resolve(root, 'locale', locale), 'utf8')) as Record<string, unknown>
      expect(Object.keys(parsed).length).toBeGreaterThan(0)
    }
  })

  it('inserts the Translator service and the client UI with anonymous defaults', () => {
    const parsed = yaml.load(readFileSync(resolve(root, './cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([
      { insert: [
        { id: 'translator', name: '@deepseek-ai/dsh-experimental-translator' },
        {
          id: 'cot-translation',
          name: '@deepseek-ai/dsh-experimental-client-ui-cot-translation',
          config: { provider: 'bing', targetLanguage: 'auto' },
        },
      ] },
    ])
  })
})
