import { describe, expect, it } from 'vitest'
import { classifyCiPrScope } from './ci-pr-scope.ts'

describe('classifyCiPrScope', () => {
  it('skips expensive lanes for pnpm action pin updates', () => {
    expect(classifyCiPrScope(
      ['.github/workflows/ci.yml', '.github/workflows/e2e.yml'],
      '-      - uses: pnpm/action-setup@v6.0.9\n+      - uses: pnpm/action-setup@v6.0.10',
    )).toEqual({ runExpensive: false, reason: 'action-only' })
  })

  it('skips expensive lanes for documentation-only changes', () => {
    expect(classifyCiPrScope(['docs/testing.md', '.agents/notes/proposed.md'], '')).toEqual({
      runExpensive: false,
      reason: 'docs-only',
    })
  })

  it('keeps expensive lanes for source and dependency changes', () => {
    expect(classifyCiPrScope(['packages/e2b/e2b/package.json', 'pnpm-lock.yaml'], '')).toEqual({
      runExpensive: true,
      reason: 'full',
    })
  })
})
