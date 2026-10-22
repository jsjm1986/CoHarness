/**
 * The experimental persistent-terminal bundle inserts one isolated Host group
 * carrying the terminal registry, the platform shell backend, and the six
 * `terminal_*` tools over the shipped Web composition, which mounts none of
 * these rows at the Host layer.
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

describe('experimental terminal bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('publishes as an experimental bundle with plugin-manager display metadata', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-experimental-terminal-bundle')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // Each touched row names a package the bundle depends on, so the rows resolve from the bundle.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-terminal', '@deepseek-ai/dsh-terminal-bash', '@deepseek-ai/dsh-tool-terminal',
    ])
  })

  it('inserts one isolated terminals group with the registry, platform backend, and tools', () => {
    const parsed = yaml.load(readFileSync(resolve(root, './cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([
      { insert: [
        {
          id: 'optional-persistent-terminals',
          name: 'cordis:group',
          group: true,
          isolate: { terminals: true },
          config: [
            { id: 'optional-terminal-registry', name: '@deepseek-ai/dsh-terminal' },
            {
              id: 'optional-terminal-bash',
              name: '@deepseek-ai/dsh-terminal-bash',
              disabled: { __jsExpr: "process.platform === 'win32'" },
            },
            {
              id: 'optional-terminal-pwsh',
              name: '@deepseek-ai/dsh-terminal-bash',
              disabled: { __jsExpr: "process.platform !== 'win32'" },
              config: { shellDialect: 'pwsh' },
            },
            { id: 'optional-tool-terminal', name: '@deepseek-ai/dsh-tool-terminal' },
          ],
        },
      ] },
    ])
  })
})
