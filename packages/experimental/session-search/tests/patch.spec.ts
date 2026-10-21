/**
 * The experimental session-search bundle inserts one isolated Host group
 * owning a private `sessionQuery` provider on a lazy in-memory index plus the
 * read-only Agent tools, leaving the shipped `session-query-sqlite` metadata
 * row (`openAt: never`) untouched.
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

describe('experimental session-search bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('publishes as an experimental bundle with plugin-manager display metadata', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-experimental-session-search')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // Each touched row names a package the bundle depends on, so the rows resolve from the bundle.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-session-query-sqlite', '@deepseek-ai/dsh-tool-session-query',
    ])
  })

  it('inserts one isolated session-search group with its own lazy index', () => {
    const parsed = yaml.load(readFileSync(resolve(root, './cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([
      { insert: [
        {
          id: 'optional-session-search',
          name: 'cordis:group',
          group: true,
          isolate: { sessionQuery: true },
          config: [
            {
              id: 'optional-session-query-sqlite',
              name: '@deepseek-ai/dsh-session-query-sqlite',
              config: { path: ':memory:', openAt: 'first-search' },
            },
            { id: 'optional-tool-session-query', name: '@deepseek-ai/dsh-tool-session-query' },
          ],
        },
      ] },
    ])
  })
})
