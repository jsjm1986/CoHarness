/** The Web bundle delivers live graphs while artifact polling remains development-only. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

function rows(): Record<string, unknown>[] {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('Web patch must parse to a patch list')
  return parsed.flatMap((patch): Record<string, unknown>[] => {
    if (typeof patch !== 'object' || patch === null) return []
    return (patch as { insert?: Record<string, unknown>[] }).insert ?? []
  })
}

describe('Web bundle composition', () => {
  it('delivers graphs in production and polls only with the explicit development switch', () => {
    const row = rows().find(candidate => candidate.id === 'client-hmr')
    if (row === undefined) throw new Error('Web patch must mount client-hmr')
    expect(row.name).toBe('@deepseek-ai/dsh-client-hmr')
    expect(row.disabled).toBeUndefined()
    const expression = (row.config as { watchArtifacts?: { __jsExpr?: string } }).watchArtifacts?.__jsExpr
    if (expression === undefined) throw new Error('client-hmr must configure artifact polling')
    expect(Boolean(evaluate({ process: { env: {} } }, expression))).toBe(false)
    expect(Boolean(evaluate({ process: { env: { DSH_CLIENT_HMR: '1' } } }, expression))).toBe(true)
    expect(Boolean(evaluate({ process: { env: { DSH_CLIENT_HMR: 'true' } } }, expression))).toBe(false)
  })
})
