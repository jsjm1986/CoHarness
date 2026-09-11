import { describe, expect, it } from 'vitest'
import { classifyCiPrScope, clientSurfacePackages } from './ci-pr-scope.ts'
import scopePolicy from './ci-scope-policy.json' with { type: 'json' }

describe('classifyCiPrScope', () => {
  it('uses a versioned declarative policy for shared and model-input paths', () => {
    expect(scopePolicy.version).toBe(1)
    expect(scopePolicy.scopedPackageGroups).toContain('util')
    expect(scopePolicy.scopedPackageGroups).not.toContain('session')
    expect(scopePolicy.modelInputPrefixes).toContain('apps/cli/config/')
    expect(scopePolicy.gatewayPrefixes).toContain('gateway/')
  })
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
      'packages/util/timeout/src/nested/reader.ts',
      'packages/util/timeout/tests/nested/reader.spec.ts',
    ], '')).toMatchObject({
      runExpensive: true,
      reason: 'scoped',
      changedSourceFiles: ['packages/util/timeout/src/nested/reader.ts'],
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
      // Coverage falls back to the full suite, but none of these packages render
      // in the browser, so the Playwright inventory stays out of the lane.
    ], '')).toMatchObject({ reason: 'full', coverageMode: 'full', snapshotMode: 'scoped' })
  })

  it('keeps the browser inventory when the lockfile or a manifest moves', () => {
    expect(classifyCiPrScope([
      'packages/session/session-format/src/catalog-default.ts',
      'pnpm-lock.yaml',
    ], '')).toMatchObject({ coverageMode: 'full', snapshotMode: 'full' })
  })

  it('drops the compatibility, Python, and Windows lanes for documentation', () => {
    expect(classifyCiPrScope(['docs/testing.md'], '')).toMatchObject({
      reason: 'docs-only',
      coverageMode: 'skip',
      compatMode: 'skip',
      pythonMode: 'skip',
      windowsMode: 'skip',
    })
  })

  it('keeps only the Python lanes for a python-only change', () => {
    expect(classifyCiPrScope([
      'python/sdk/src/deepseek_harness/session.py',
    ], '')).toMatchObject({
      reason: 'python-only',
      runExpensive: false,
      coverageMode: 'skip',
      snapshotMode: 'skip',
      compatMode: 'full',
      pythonMode: 'full',
      windowsMode: 'skip',
    })
  })

  it('keeps the Windows and compatibility lanes for a script change', () => {
    expect(classifyCiPrScope([
      'scripts/run-gates.ts',
    ], '')).toMatchObject({
      reason: 'full',
      coverageMode: 'full',
      compatMode: 'full',
      pythonMode: 'skip',
      windowsMode: 'full',
    })
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
      'packages/util/timeout/src/index.ts',
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

  it('forces full runtime coverage for Session and Cordis seams', () => {
    for (const path of [
      'packages/core/session/src/index.ts',
      'packages/typert/generator/src/analyzer.ts',
      'packages/client/connection/src/index.ts',
    ]) {
      expect(classifyCiPrScope([path], '')).toMatchObject({
        reason: 'full',
        coverageMode: 'full',
        gatewayMode: 'skip',
      })
    }
  })

  it('fails closed for a new package group until its impact is classified', () => {
    expect(classifyCiPrScope(['packages/future/new-capability/src/index.ts'], '')).toMatchObject({
      reason: 'full',
      coverageMode: 'full',
    })
  })

  it('treats model-visible skill files as runtime inputs', () => {
    expect(classifyCiPrScope([
      'apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md',
    ], '')).toMatchObject({
      changedDocsOnly: false,
      reason: 'full',
      runExpensive: true,
      snapshotMode: 'scoped',
    })
  })

  it('selects the independent Gateway lanes for cloud protocol changes', () => {
    expect(classifyCiPrScope(['gateway/src/principal.ts'], '')).toMatchObject({
      reason: 'full',
      gatewayMode: 'full',
      adminUiMode: 'skip',
    })
    expect(classifyCiPrScope(['gateway/admin-ui/src/App.tsx'], '')).toMatchObject({
      reason: 'full',
      gatewayMode: 'full',
      adminUiMode: 'full',
    })
    expect(classifyCiPrScope(['packages/util/timeout/package.json'], '')).toMatchObject({
      gatewayMode: 'skip',
      adminUiMode: 'skip',
    })
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
