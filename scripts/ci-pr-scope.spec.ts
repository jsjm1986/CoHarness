import * as childProcess from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { classifyCiPrScope, classifyWebVerification, clientSurfacePackages, resolveCiPrScopePlans } from './ci-pr-scope.ts'
import scopePolicy from './ci-scope-policy.json' with { type: 'json' }
import { exactScenarioFiles, focusedScenarioFiles, loadWebTestPolicy, scanGoldenOwners } from './web-test-policy.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

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

  it('does not read a run line mentioning the action ref as a pin update', () => {
    expect(classifyCiPrScope(
      ['.github/workflows/ci.yml'],
      '-      - run: pnpm test # pnpm/action-setup@v6\n+      - run: echo skipped # pnpm/action-setup@v6',
    ).reason).not.toBe('action-only')
  })

  it('reads golden and provider-owned model assets as test inputs, not docs', () => {
    expect(classifyCiPrScope(
      ['examples/acp-agent/tests/snapshots/text-turn/system-prompt.expected.md'],
      '',
    ).reason).not.toBe('docs-only')
    expect(classifyCiPrScope(
      ['packages/skill/skill-badge/assets/dsh-badge.md'],
      '',
    ).reason).not.toBe('docs-only')
    expect(classifyCiPrScope(['README.md'], '')).toMatchObject({ reason: 'docs-only' })
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

  it('keeps ordinary accompanying prose out of a scoped package decision', () => {
    const source = 'packages/util/timeout/src/index.ts'
    const original = classifyCiPrScope([source], '')
    expect(classifyCiPrScope([
      source,
      'packages/util/timeout/README.md',
      'packages/util/timeout/README.zh.md',
      'packages/util/timeout/README.i18n.yaml',
      '.agents/notes/implemented/process/change.md',
      'docs/testing.md',
      'gateway/README.md',
    ], '')).toEqual(original)
    expect(original.coverageMode).toBe('scoped')
  })

  it('retains model inputs, goldens, and configurations beside ordinary source changes', () => {
    for (const companion of [
      'packages/util/timeout/cordis.yml',
      'packages/util/timeout/package.json',
      'docs/examples/cordis.yml',
      'packages/skill/skill-badge/assets/dsh-badge.md',
      '.agents/skills/example/SKILL.md',
      'examples/acp-agent/tests/snapshots/text-turn/system-prompt.expected.md',
      'scripts/snapshots/python-sdk-single-exe/model.expected.md',
      'packages/util/timeout/tests/fixtures/output.expected.md',
    ]) {
      expect(classifyCiPrScope(['packages/util/timeout/src/index.ts', companion], '').coverageMode, companion).toBe('full')
    }
  })

  it('keeps the scoped package limit and unknown-package fallback with accompanying prose', () => {
    const paths = ['one', 'two', 'three', 'four'].map(name => `packages/util/${name}/src/index.ts`)
    expect(classifyCiPrScope([...paths, 'docs/testing.md'], '').coverageMode).toBe('scoped')
    expect(classifyCiPrScope([...paths, 'packages/util/five/src/index.ts', 'docs/testing.md'], '').coverageMode).toBe('full')
    expect(classifyCiPrScope(['packages/future/new/src/index.ts', 'docs/testing.md'], '').coverageMode).toBe('full')
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
    expect(classifyCiPrScope(['packages/subprocess/subprocess/package.json', 'pnpm-lock.yaml'], '')).toMatchObject({
      runExpensive: true,
      reason: 'full',
      changedSourceFiles: [],
      changedPackageFiles: ['packages/subprocess/subprocess/package.json', 'pnpm-lock.yaml'],
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
      'packages/session/session-format/src/chain.ts',
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
      'packages/session/session-format/src/chain.ts',
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
      compatMode: 'skip',
      pythonMode: 'full',
      windowsMode: 'skip',
    })
  })

  it('runs only the Admin lane for a standalone admin page change', () => {
    expect(classifyCiPrScope([
      'gateway/admin-ui/src/pages/UsersPage.tsx',
    ], '')).toMatchObject({
      reason: 'consumer-only',
      gatewayMode: 'skip',
      adminUiMode: 'full',
      compatMode: 'skip',
      coverageMode: 'skip',
      snapshotMode: 'skip',
      windowsMode: 'skip',
    })
    expect(classifyCiPrScope(['gateway/src/server.ts'], '')).toMatchObject({
      gatewayMode: 'full',
      adminUiMode: 'skip',
    })
  })

  it('keeps the Windows and compatibility lanes for a script change', () => {
    expect(classifyCiPrScope([
      'scripts/run-gates.ts',
    ], '')).toMatchObject({
      reason: 'full',
      coverageMode: 'full',
      compatMode: 'full',
      pythonMode: 'full',
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
      webGroups: ['documents', 'lifecycle', 'shell', 'workbench'],
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

  it('honors an explicit browser consumer even without the discovered package set', () => {
    expect(classifyCiPrScope([
      'packages/client/ui-conversation/src/message-row.ts',
    ], '')).toMatchObject({ reason: 'scoped', snapshotMode: 'focused', webGroups: ['conversation', 'mobile', 'subagent', 'workbench'] })
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
        gatewayMode: 'full',
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

  it.each(['dsh-directory-guard', 'dsh-model-governance'])('runs Gateway and runtime lanes for %s changes', (plugin) => {
    for (const file of ['src/index.ts', 'tests/plugin.spec.ts', 'vitest.config.ts']) {
      expect(classifyCiPrScope([`plugins/${plugin}/${file}`], '')).toMatchObject({
        runExpensive: true,
        reason: 'full',
        coverageMode: 'full',
        gatewayMode: 'full',
        adminUiMode: plugin === 'dsh-model-governance' ? 'full' : 'skip',
      })
    }
  })

  it('selects the independent Gateway lanes for cloud protocol changes', () => {
    expect(classifyCiPrScope(['gateway/src/principal.ts'], '')).toMatchObject({
      reason: 'full',
      gatewayMode: 'full',
      adminUiMode: 'skip',
    })
    expect(classifyCiPrScope(['gateway/admin-ui/src/App.tsx'], '')).toMatchObject({
      reason: 'consumer-only',
      gatewayMode: 'skip',
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
  const policy = loadWebTestPolicy(process.cwd())
  const goldenOwners = scanGoldenOwners(process.cwd())

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
      'packages/session/session-format/src/chain.ts',
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

  it('routes scenario-only changes to their exact entries plus every smoke', () => {
    expect(web(['apps/web/tests/goal-bar.e2e.ts'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: [],
      webScenarios: exactScenarioFiles(policy, ['goal-bar.e2e.ts']),
    })
    expect(web(['apps/web/tests/workbench.e2e.ts'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: [],
      webScenarios: exactScenarioFiles(policy, ['workbench.e2e.ts']),
    })
  })

  it('routes the shared ACP edit fixture to its real browser consumer', () => {
    expect(web(['examples/acp-agent/tests/snapshots/fs-edit/session.v6.jsonl'])).toMatchObject({
      runExpensive: true,
      snapshotMode: 'focused',
      webGroups: [], webScenarios: expect.arrayContaining(['diff-context.e2e.ts']) as string[],
    })
  })

  it('selects every shared-input owner and the common smoke scenarios', () => {
    const policy = loadWebTestPolicy(process.cwd())
    const input = 'examples/acp-agent/tests/snapshots/fs-edit/session.v6.jsonl'
    const combined = {
      ...policy,
      sharedInputs: { ...policy.sharedInputs, [input]: ['diff-context.e2e.ts', 'workbench.e2e.ts'] },
    }
    const plan = classifyWebVerification([input], packages, combined, new Map())
    expect(plan).toEqual({ mode: 'focused', groups: [], scenarios: exactScenarioFiles(combined, ['diff-context.e2e.ts', 'workbench.e2e.ts']) })
    const selected = plan.scenarios
    expect(selected).toEqual(expect.arrayContaining(['diff-context.e2e.ts', 'workbench.e2e.ts', ...policy.smokeScenarios]))
    expect(selected).not.toContain('subagent-conversation.e2e.ts')
  })

  it('treats a declared Markdown input as runtime evidence while leaving unrelated examples scoped', () => {
    const policy = loadWebTestPolicy(process.cwd())
    const input = 'examples/shared-prose.md'
    const supplied = { ...policy, sharedInputs: { ...policy.sharedInputs, [input]: ['diff-context.e2e.ts'] } }
    expect(classifyCiPrScope([input], '', packages, supplied)).toMatchObject({
      runExpensive: true, changedDocsOnly: false, snapshotMode: 'focused', webGroups: [], webScenarios: exactScenarioFiles(supplied, ['diff-context.e2e.ts']),
    })
    expect(web(['examples/acp-agent/tests/snapshots/unrelated/session.jsonl'])).toMatchObject({
      snapshotMode: 'scoped', webGroups: [],
    })
    expect(web(['examples/acp-agent/tests/snapshots/fs-edit/session.v6.jsonl.backup'])).toMatchObject({
      snapshotMode: 'scoped', webGroups: [],
    })
    expect(web(['new-runtime-input.dat'])).toMatchObject({ snapshotMode: 'full' })
  })

  it('fails on a shared relation with no registered consumer instead of falling back', () => {
    const policy = loadWebTestPolicy(process.cwd())
    const input = 'examples/acp-agent/tests/snapshots/fs-edit/session.v6.jsonl'
    expect(() => classifyWebVerification([input], packages, {
      ...policy, sharedInputs: { [input]: ['removed.e2e.ts'] },
    }, new Map())).toThrow(/unknown scenario/)
  })

  it('does not let a shared-input declaration narrow runtime or dependency validation', () => {
    const policy = loadWebTestPolicy(process.cwd())
    for (const input of ['pnpm-lock.yaml', 'packages/client/runtime/src/index.ts', 'scripts/web-test-policy.json']) {
      expect(classifyWebVerification([input], packages, {
        ...policy, sharedInputs: { [input]: ['diff-context.e2e.ts'] },
      }, new Map())).toEqual({ mode: 'full', groups: [], scenarios: [] })
    }
  })

  it('routes a committed golden to every referencing scenario without the rest of their groups', () => {
    expect(web(['apps/web/tests/snapshots/goal-bar/active.expected.md'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: [],
      webScenarios: exactScenarioFiles(policy, ['goal-bar.e2e.ts']),
    })
    expect(web(['apps/web/tests/snapshots/seeded-history/seed.jsonl'])).toMatchObject({
      snapshotMode: 'focused',
      webGroups: [],
      webScenarios: exactScenarioFiles(policy, goldenOwners.get('seeded-history') ?? []),
    })
  })

  it('unions shared golden owners and source scenarios while ignoring accompanying prose', () => {
    const paths = [
      'apps/web/tests/snapshots/seeded-history/seed.jsonl',
      'apps/web/tests/goal-bar.e2e.ts',
      'apps/web/tests/README.md',
      '.agents/notes/implemented/testing/web.md',
    ]
    const expected = exactScenarioFiles(policy, [...goldenOwners.get('seeded-history') ?? [], 'goal-bar.e2e.ts'])
    expect(web(paths)).toMatchObject({ snapshotMode: 'focused', webGroups: [], webScenarios: expected })
    expect(expected).not.toContain('queue-actions.e2e.ts')
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
    ])).toMatchObject({ snapshotMode: 'focused', webGroups: ['conversation'], webScenarios: [] })
  })

  it('keeps a UI change focused when it carries its own scenario and golden', () => {
    expect(web([
      'packages/client/ui-goal/src/row.ts',
      'apps/web/tests/goal-bar.e2e.ts',
      'apps/web/tests/snapshots/goal-bar/active.expected.md',
    ])).toMatchObject({ snapshotMode: 'focused', webGroups: ['conversation'], webScenarios: [] })
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
    )).toEqual({ mode: 'full', groups: [], scenarios: [] })
  })

  it('never narrows shared inputs or model-visible test documents to exact scenarios', () => {
    for (const companion of ['apps/web/tests/scaffold.ts', 'pnpm-lock.yaml', 'apps/web/tests/AGENTS.md']) {
      expect(web(['apps/web/tests/goal-bar.e2e.ts', companion]), companion)
        .toMatchObject({ snapshotMode: 'full', webGroups: [], webScenarios: [] })
    }
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

describe('complete scope shadow comparison', () => {
  const root = process.cwd()
  const policy = loadWebTestPolicy(root)

  it('retains the frozen full coverage decision while reporting the narrower candidate', () => {
    const plan = resolveCiPrScopePlans(['packages/util/timeout/src/index.ts', 'docs/testing.md'], '', root, {})
    expect(plan).toMatchObject({ baselineStatus: 'available', policy: 'shadow', executionSource: 'shadow-union' })
    expect(plan.previous.coverageMode).toBe('full')
    expect(plan.candidate.coverageMode).toBe('scoped')
    expect(plan.execution.coverageMode).toBe('full')
    expect(plan.changes.removed).toContainEqual({
      lane: 'coverage', from: 'full', to: 'scoped', reason: 'accompanying-inert-prose',
    })
  })

  it('executes every previous Web-group member while comparing exact owner selection', () => {
    const plan = resolveCiPrScopePlans(['apps/web/tests/goal-bar.e2e.ts'], '', root, {})
    expect(plan.previous).toMatchObject({ snapshotMode: 'focused', webGroups: ['conversation'], webScenarios: [] })
    expect(plan.candidate.webScenarios).toEqual(exactScenarioFiles(policy, ['goal-bar.e2e.ts']))
    expect(plan.execution.webScenarios).toEqual(focusedScenarioFiles(policy, ['conversation']))
    expect(plan.execution.webScenarios).toContain('queue-actions.e2e.ts')
    const webReduction = plan.changes.removed.find(change => change.lane === 'web')
    expect(webReduction?.from).toContain('queue-actions.e2e.ts')
    expect(webReduction?.reason).toBe('exact-scenario-owners-and-smokes')
  })

  it('records additional validation for a golden the previous policy classified as prose', () => {
    const plan = resolveCiPrScopePlans(['scripts/snapshots/python-sdk-single-exe/model.expected.md'], '', root, {})
    expect(plan.previous).toMatchObject({ reason: 'docs-only', coverageMode: 'skip', pythonMode: 'skip' })
    expect(plan.candidate).toMatchObject({ coverageMode: 'full', pythonMode: 'full' })
    expect(plan.execution).toMatchObject({ coverageMode: 'full', pythonMode: 'full' })
    expect(plan.changes.added).toContainEqual(expect.objectContaining({ lane: 'pythonMode', from: 'skip', to: 'full' }))
  })

  it('explains the old shared-prefix README expansion without narrowing actual shared runtime inputs', () => {
    const source = 'packages/client/ui-conversation/src/client/chat/ChatView.tsx'
    const plan = resolveCiPrScopePlans([source, 'packages/client/runtime/README.md'], '', root, {})
    expect(plan.previous.snapshotMode).toBe('full')
    expect(plan.candidate).toMatchObject({ snapshotMode: 'focused', webGroups: ['conversation', 'mobile', 'subagent', 'workbench'] })
    expect(plan.changes.removed.find(change => change.lane === 'web')?.reason).toBe('accompanying-inert-prose')
    expect(plan.execution.snapshotMode).toBe('full')
    const shared = resolveCiPrScopePlans([source, 'packages/client/runtime/src/index.ts'], '', root, {})
    expect(shared.candidate.snapshotMode).toBe('full')
    expect(shared.changes.removed).toEqual([])
  })

  it('uses candidate selection only for an explicit experiment', () => {
    const plan = resolveCiPrScopePlans(['apps/web/tests/goal-bar.e2e.ts'], '', root, { DSH_CI_SCOPE_POLICY: 'candidate' })
    expect(plan.executionSource).toBe('candidate-experiment')
    expect(plan.execution).toBe(plan.candidate)
    expect(plan.execution.webScenarios).not.toContain('queue-actions.e2e.ts')
  })

  it.each(['', 'auto', 'Candidate', ' candidate'])('rejects the unknown decision policy %j', (value) => {
    expect(() => resolveCiPrScopePlans(['README.md'], '', root, { DSH_CI_SCOPE_POLICY: value }))
      .toThrow(/must be exactly shadow or candidate/)
  })

  it('keeps full validation when historical Git evidence is unavailable', () => {
    const git = vi.mocked(childProcess.execFileSync)
    git.mockImplementationOnce(() => { throw new Error('historical object unavailable') })
    try {
      const plan = resolveCiPrScopePlans(['README.md'], '', root, {})
      expect(plan).toMatchObject({ baselineStatus: 'unavailable', baselineError: 'historical object unavailable' })
      expect(plan.candidate.coverageMode).toBe('skip')
      expect(plan.execution).toMatchObject({
        coverageMode: 'full', snapshotMode: 'full', compatMode: 'full', windowsMode: 'full',
        pythonMode: 'full', gatewayMode: 'full', adminUiMode: 'full',
      })
    } finally { git.mockReset() }
  })

  it('does not turn invalid current configuration into historical fallback', () => {
    expect(() => resolveCiPrScopePlans(['README.md'], '', resolve(root, 'missing-scope-fixture'), {})).toThrow(/ENOENT/)
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

it('selects assembled Admin plugin verification without unrelated runtime matrices', () => {
  for (const path of ['gateway/admin-ui/src/plugins/transport.ts', 'gateway/admin-ui/src/pages/PluginsPage.tsx', 'gateway/admin-ui/src/App.tsx']) {
    expect(classifyCiPrScope([path], '')).toMatchObject({
      runExpensive: false, coverageMode: 'skip', compatMode: 'skip', windowsMode: 'skip',
      adminUiMode: 'full', snapshotMode: 'focused', webGroups: [], webScenarios: expect.arrayContaining(['plugin-administration.e2e.ts']) as string[],
    })
  }
  for (const path of ['packages/boot/plugin-manager/src/index.ts', 'packages/host/plugin-inventory/src/index.ts']) {
    expect(classifyCiPrScope([path], '', new Set())).toMatchObject({
      adminUiMode: 'full', snapshotMode: 'focused', webGroups: ['settings'], webScenarios: [],
    })
  }
})
