import { describe, expect, it } from 'vitest'
import { importDeclarationIsTypeOnly, resolveClientImport } from './verify-client-domain-graph.ts'

describe('client domain import resolution', () => {
  it('preserves imports that leave src/client from a top-level file', () => {
    expect(resolveClientImport('styles.ts', '../styles/base.css?inline'))
      .toBe('../styles/base.css?inline')
  })

  it('normalizes imports between domains inside src/client', () => {
    expect(resolveClientImport('input/hub.ts', '../queue/store.ts'))
      .toBe('queue/store.ts')
  })

  it('distinguishes erased type-only imports from live value imports', () => {
    const typeSource = 'import type { Row } from \'../rows/Rows.tsx\'\nconst x = 1\n'
    const valueSource = 'import { Row } from \'../rows/Rows.tsx\'\nconst x = 1\n'
    expect(importDeclarationIsTypeOnly(typeSource, typeSource.indexOf('from'))).toBe(true)
    expect(importDeclarationIsTypeOnly(valueSource, valueSource.indexOf('from'))).toBe(false)
  })
})
