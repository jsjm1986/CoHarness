/**
 * The experimental Ralph bundle inserts one isolated Host group owning a
 * private `workflowEngine` plus the model-facing `ralph` tool, leaving the
 * shipped parked `tool-ralph` and (on Web) `workflow-ptc` host rows untouched.
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

describe('experimental Ralph bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('publishes as an experimental bundle with plugin-manager display metadata', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-experimental-ralph-bundle')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // Each touched row names a package the bundle depends on, so the rows resolve from the bundle.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-tool-ralph', '@deepseek-ai/dsh-workflow-ptc',
    ])
  })

  it('inserts one isolated Ralph group with its own workflow engine', () => {
    const parsed = yaml.load(readFileSync(resolve(root, './cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([
      { insert: [
        {
          id: 'optional-ralph',
          name: 'cordis:group',
          group: true,
          isolate: { workflowEngine: true },
          config: [
            {
              id: 'optional-ralph-workflow',
              name: '@deepseek-ai/dsh-workflow-ptc',
              config: { provider: 'spawn' },
            },
            {
              id: 'tool-ralph',
              name: '@deepseek-ai/dsh-tool-ralph',
              config: { subagentProvider: 'spawn', maxRounds: 64 },
            },
          ],
        },
      ] },
    ])
  })
})
