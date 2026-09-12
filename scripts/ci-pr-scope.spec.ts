import { describe, expect, it } from 'vitest'
import { classifyCiPrScope, classifyWebVerification, clientSurfacePackages } from './ci-pr-scope.ts'
import scopePolicy from './ci-scope-policy.json' with { type: 'json' }
import { loadWebTestPolicy } from './web-test-policy.ts'

describe('classifyCiPrScope', () => {
  it('uses a versioned declarative policy for shared and model-input paths', () => {
    expect(scopePolicy.version).toBe(1)
    expect(scopePolicy.inertPrefixes).toContain('upgrades/')
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

  it('skips expensive lanes for upgrade and engineering records, including JSON', () => {
    expect(classifyCiPrScope([
      'upgrades/plans/UPGRADE-PLAN-dsh-v0.1.5-alpha.1.md',
      'upgrades/manifests/UPGRADE-MANIFEST-dsh-v0.1.5-alpha.1.json',
      'upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.1.5-alpha.1.json',
      'engineering/BENCHMARK.md',
    ], '')).toMatchObject({
      runExpensive: false,
      reason: 'docs-only',
      changedDocsOnly: true,
      coverageMode: 'skip',
      snapshotMode: 'skip',
      compatMode: 'skip',
      pythonMode: 'skip',
      windowsMode: 'skip',
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

  it('focuses web verification on the changed browser-rendered package group', () => {
    expect(classifyCiPrScope([
      'packages/client/ui-conversation/src/message-row.ts',
    ], '', new Set(['client/ui-conversation']))).toMatchObject({
      reason: 'scoped',
      coverageMode: 'scoped',
      snapshotMode: 'focused',
      webGroups: ['conversation', 'mobile', 'subagent', 'workbench'],
    })
  })

  it('focuses web verification on every group a shared UI package reaches', () => {
    expect(classifyCiPrScope([
      'packages/client/ui-workbench/src/pane.ts',
    ], '', new Set(['client/ui-workbench']))).toMatchObject({
      snapshotMode: 'focused',
      webGroups: ['lifecycle', 'shell', 'workbench'],
    })
  })

  it('keeps the scoped snapshot when no changed package is browser-rendered', () => {
    expect(classifyCiPrScope([
      'packages/util/timeout/src/index.ts',
    ], '', new Set(['client/ui-conversation']))).toMatchObject({
      reason: 'scoped',
      coverageMode: 'scoped',
      snapshotMode: 'scoped',
      webGroups: [],
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

describe('web verification tier selection', () => {
  const packages = clientSurfacePackages(process.cwd())

  function web(paths: readonly string[], supplied = packages) {
    return classifyCiPrScope(paths, '', supplied)
  }

  it('runs the full inventory for web app, runtime, loader, and api changes', () => {
    for (const path of [
      'apps/web/src/main.ts',
      'apps/web/public/manifest.webmanifest',
      'apps/web/index.html',
      'apps/web/vite.config.ts',
      'apps/web/package.json',
      'packages/client/runtime/src/boot.ts',
      'packages/client/connection/src/socket.ts',
      'packages/client/modules/src/loader.ts',
      'packages/client/web/src/kernel.ts',
      'packages/api/remotes/src/web.ts',
      'packages/api/gateway/src/plugin.ts',
      'packages/extensions/cordis-client-runner/src/run.ts',
      'packages/typert/registry/src/face.ts',
      'packages/host/apiproxy/src/fetch.ts',
    ]) {
      expect(web([path]), path).toMatchObject({ snapshotMode: 'full', webGroups: [] })
    }
  })

  it('runs the full inventory for dependency, web-infra, and gateway changes', () => {
    for (const path of [
      'pnpm-lock.yaml',
      'packages/client/ui-goal/package.json',
      'scripts/run-web-snapshots.ts',
      'scripts/web-test-policy.json',
      'vitest.web.config.ts',
      'gateway/src/plugin.ts',
    ]) {
      expect(web([path]), path).toMatchObject({ snapshotMode: 'full', webGroups: [] })
    }
  })

  it('falls back to the full inventory for an unmapped browser-rendered package', () => {
    expect(web(['packages/fake/unknown/src/row.ts'], new Set(['fake/unknown']))).toMatchObject({
      snapshotMode: 'full',
    })
  })

  it('keeps web verification out of provably browser-irrelevant paths', () => {
    for (const path of [
      'scripts/verify-md-links.ts',
      '.github/workflows/ci.yml',
      'vitest.snapshot.config.ts',
      'knip.config.ts',
      '.oxlintrc.json',
      'packages/session/session-format/src/catalog-default.ts',
      'packages/interaction/commands/src/router.ts',
      'apps/cli/tests/source-launch.compat.spec.ts',
      'python/sdk/src/deepseek_harness/session.py',
      'examples/acp-agent/cordis.yml',
    ]) {
      const expected = path.startsWith('python/') ? 'skip' : 'scoped'
      expect(web([path]), path).toMatchObject({ snapshotMode: expected, webGroups: [] })
    }
  })

  it('treats unclassified root sources as full-inventory triggers', () => {
    expect(web(['vitest.shared.ts'])).toMatchObject({ snapshotMode: 'full' })
  })

  it('routes a scenario file to its owning business group', () => {
    expect(web(['apps/web/tests/goal-bar.e2e.ts'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: ['conversation'],
    })
    expect(web(['apps/web/tests/workbench.e2e.ts'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: ['workbench'],
    })
  })

  it('routes a committed golden to the groups of the scenarios that reference it', () => {
    expect(web(['apps/web/tests/snapshots/goal-bar/active.expected.md'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: ['conversation'],
    })
    expect(web(['apps/web/tests/snapshots/seeded-history/seed.jsonl'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: ['conversation', 'documents', 'lifecycle', 'workbench'],
    })
  })

  it('runs the full inventory for unowned goldens and shared test fixtures', () => {
    for (const path of [
      'apps/web/tests/snapshots/no-such-golden/ui.expected.md',
      'apps/web/tests/assembled-boot.ts',
      'apps/web/tests/chat-scroll-fixture.ts',
      'apps/web/tests/agent-preset-authoring.overlay.yml',
      'apps/web/tests/support/listen-probe.mjs',
    ]) {
      expect(web([path]), path).toMatchObject({ snapshotMode: 'full', webGroups: [] })
    }
  })

  it('keeps test-tree documentation inert instead of widening the selection', () => {
    expect(web(['apps/web/tests/README.md'])).toMatchObject({ reason: 'docs-only', snapshotMode: 'skip' })
    expect(web([
      'packages/client/ui-goal/src/row.ts',
      'apps/web/tests/README.md',
    ])).toMatchObject({ snapshotMode: 'focused', webGroups: ['conversation'] })
  })

  it('keeps a UI change focused when it carries its own scenario and golden', () => {
    expect(web([
      'packages/client/ui-goal/src/row.ts',
      'apps/web/tests/goal-bar.e2e.ts',
      'apps/web/tests/snapshots/goal-bar/active.expected.md',
    ])).toMatchObject({ snapshotMode: 'focused', webGroups: ['conversation'] })
  })

  it('focuses every group a multi-group package mapping reaches', () => {
    expect(web(['packages/client/ui-commands/src/client/index.ts'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: ['conversation', 'workbench'],
    })
  })

  it('runs the full inventory when a golden owner is outside the scenario table', () => {
    const owners = new Map<string, readonly string[]>([
      ['half-known', ['goal-bar.e2e.ts', 'removed-scenario.e2e.ts']],
    ])
    expect(classifyWebVerification(
      ['apps/web/tests/snapshots/half-known/ui.expected.md'],
      packages,
      loadWebTestPolicy(process.cwd()),
      owners,
    )).toEqual({ mode: 'full', groups: [] })
  })

  it('focuses a mixed UI-and-inert change but upgrades to full with a dependency', () => {
    expect(web([
      'packages/client/ui-goal/src/row.ts',
      'docs/testing.md',
    ])).toMatchObject({ snapshotMode: 'focused', webGroups: ['conversation'] })
    expect(web([
      'packages/client/ui-goal/src/row.ts',
      'pnpm-lock.yaml',
    ])).toMatchObject({ snapshotMode: 'full', webGroups: [] })
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
