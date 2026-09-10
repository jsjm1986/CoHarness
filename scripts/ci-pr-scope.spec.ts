import { describe, expect, it } from 'vitest'
import { classifyCiPrScope } from './ci-pr-scope.ts'

describe('classifyCiPrScope', () => {
  it('skips expensive lanes for pnpm action pin updates', () => {
    expect(classifyCiPrScope(
      ['.github/workflows/ci.yml', '.github/workflows/e2e.yml'],
      '-      - uses: pnpm/action-setup@v6.0.9\n+      - uses: pnpm/action-setup@v6.0.10',
    )).toMatchObject({ runExpensive: false, reason: 'action-only', changedDocsOnly: false, coverageMode: 'skip', snapshotMode: 'skip' })
  })

  it('skips expensive lanes for documentation-only changes', () => {
    expect(classifyCiPrScope(['docs/testing.md', '.agents/notes/proposed.md'], '')).toMatchObject({
      runExpensive: false,
      reason: 'docs-only',
      changedDocsOnly: true,
      coverageMode: 'skip',
      snapshotMode: 'skip',
    })
  })

  it('keeps expensive lanes for source and dependency changes', () => {
    expect(classifyCiPrScope(['packages/e2b/e2b/package.json', 'pnpm-lock.yaml'], '')).toMatchObject({
      runExpensive: true,
      reason: 'full',
      changedSourceFiles: [],
      changedPackageFiles: ['packages/e2b/e2b/package.json', 'pnpm-lock.yaml'],
      changedDocsOnly: false,
      coverageMode: 'full',
      snapshotMode: 'full',
    })
  })

  it('selects the scoped lane for package source and test changes only', () => {
    expect(classifyCiPrScope([
      'packages/session/session-format/src/catalog-default.ts',
      'packages/session/session-format/tests/catalog.spec.ts',
    ], '')).toMatchObject({
      runExpensive: true,
      reason: 'scoped',
      changedSourceFiles: ['packages/session/session-format/src/catalog-default.ts'],
      changedPackageFiles: [],
      changedDocsOnly: false,
      coverageMode: 'scoped',
      snapshotMode: 'scoped',
    })
  })

  it('falls back to full when a scoped candidate touches metadata or infra', () => {
    expect(classifyCiPrScope([
      'packages/session/session-format/src/catalog-default.ts',
      'packages/session/session-format/package.json',
    ], '')).toMatchObject({ reason: 'full', coverageMode: 'full', snapshotMode: 'full' })
  })

  it('falls back to full when the scoped package count exceeds the bound', () => {
    expect(classifyCiPrScope([
      'packages/a/a1/src/x.ts',
      'packages/b/b1/src/x.ts',
      'packages/c/c1/src/x.ts',
      'packages/d/d1/src/x.ts',
      'packages/e/e1/src/x.ts',
    ], '')).toMatchObject({ reason: 'full', coverageMode: 'full', snapshotMode: 'full' })
  })
})
