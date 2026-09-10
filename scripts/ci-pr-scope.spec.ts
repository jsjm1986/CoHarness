import { describe, expect, it } from 'vitest'
import { classifyCiPrScope, clientSurfacePackages } from './ci-pr-scope.ts'

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

  it('keeps the browser snapshot when a scoped change touches a browser-rendered package', () => {
    expect(classifyCiPrScope([
      'packages/client/ui-conversation/src/message-row.ts',
    ], '', new Set(['client/ui-conversation']))).toMatchObject({
      reason: 'scoped',
      coverageMode: 'scoped',
      snapshotMode: 'full',
    })
  })

  it('keeps the scoped snapshot when no changed package is browser-rendered', () => {
    expect(classifyCiPrScope([
      'packages/session/session-format/src/catalog-default.ts',
    ], '', new Set(['client/ui-conversation']))).toMatchObject({
      reason: 'scoped',
      coverageMode: 'scoped',
      snapshotMode: 'scoped',
    })
  })

  it('keeps the scoped snapshot when the browser surface is not supplied', () => {
    expect(classifyCiPrScope([
      'packages/client/ui-conversation/src/message-row.ts',
    ], '')).toMatchObject({ reason: 'scoped', snapshotMode: 'scoped' })
  })
})

describe('clientSurfacePackages', () => {
  it('covers the browser-rendered packages that live outside packages/client', () => {
    const packages = clientSurfacePackages(process.cwd())
    // The client surface spans two markers; neither is sufficient alone.
    expect(packages.has('client/ui-conversation')).toBe(true)
    expect(packages.has('client/ui-primitives')).toBe(true)
    expect(packages.has('extensions/ui-cordis')).toBe(true)
    expect(packages.has('session/session-format')).toBe(false)
  })
})
