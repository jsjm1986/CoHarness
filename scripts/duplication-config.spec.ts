import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('duplication gate configuration', () => {
  it('fails above the recorded source baseline instead of failing on any historical clone', () => {
    const config = JSON.parse(readFileSync(resolve(root, '.jscpd.json'), 'utf8')) as {
      threshold?: unknown
      exitCode?: unknown
      reporters?: unknown
    }

    expect(config).toMatchObject({
      threshold: 0.115,
      reporters: ['console'],
    })
    expect(config).not.toHaveProperty('exitCode')
  })
})
