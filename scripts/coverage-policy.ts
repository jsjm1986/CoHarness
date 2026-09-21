/** Shared source measurement and platform exclusions for Vitest and repository gates. */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { resolvePwshPath } from '../packages/shell/pwsh-local/src/resolve.ts'
import { coverageBaselineFiles } from './coverage-baseline.ts'
import { COVERAGE_LINT_PROBE, pureTypeCoverageSources, type CoverageSelection } from './coverage-selection.ts'

/** Coverage selection plus the platform's unit-test exclusions. */
export interface CoveragePolicy extends CoverageSelection {
  readonly excludedTests: readonly string[]
}

/**
 * Resolve the same source policy for full, partitioned and changed-source runs.
 * @param platform - operating system whose source is measured.
 * @param pwshAvailable - whether the real PowerShell probe succeeded.
 * @returns coverage and test exclusions for that environment.
 */
export function resolveCoveragePolicy(platform: NodeJS.Platform, pwshAvailable: boolean): CoveragePolicy {
  const windowsUnsupportedPackages = platform === 'win32'
    ? [
      // Bash-requiring suites (a real POSIX shell is unavailable on Windows).
      // The pwsh-requiring suites (pwsh-local, tool-pwsh) deliberately stay
      // INCLUDED: PowerShell ships with Windows, so they run natively here.
      // This explicit list (not a 'packages/shell/*' glob) keeps
      // packages/shell/shell — the Service Definition package — running on Windows.
      'packages/shell/bash-local',
      'packages/shell/bash-sandbox',
      'packages/shell/tool-bash',
      'packages/hooks/*',
      'packages/terminal/terminal-bash',
      'packages/experimental/ptc-runtime-python',
      'packages/sandbox/sandbox-local',
    ]
    : []

  const windowsUnsupportedTests = platform === 'win32'
    ? [
      ...windowsUnsupportedPackages.map(path => `${path}/tests/**/*.spec.ts`),
      'packages/subprocess/subprocess/tests/**/*.spec.ts',
      'packages/subprocess/subprocess-local/tests/local.spec.ts',
      'packages/subprocess/subprocess-local/tests/process-inspector.spec.ts',
      'packages/subprocess/subprocess-local/tests/spawn.spec.ts',
      'packages/subprocess/subprocess-local/tests/terminal.spec.ts',
    ]
    : []

  const windowsUnsupportedCoveragePackages = platform === 'win32'
    ? [...windowsUnsupportedPackages, 'packages/subprocess/*']
    : []

  // Windows-only packages: their sources execute exclusively on win32 (koffi
  // loads Win32 libraries), so the Linux coverage lane can never cover them.
  // The Windows dev/CI lane exercises them through the probe/runner suites; the
  // per-file 100% gate must not fail on their Linux-uncovered paths.
  const windowsOnlyCoverageExclusions = platform !== 'win32'
    ? [
      'packages/sandbox/sandbox-windows-acl/src/**/*.ts',
      // The koffi-backed Win32 table (Toolhelp32/GetProcessTimes/taskkill)
      // executes only on win32; its decision logic is unit-pinned on every
      // host through the injected-internals suites.
      'packages/subprocess/subprocess-local/src/windows-inspector.ts',
    ]
    : []

  // The confinement runner entry executes exclusively as a spawned child
  // process (the sandbox seam's argv-prefix wrapper): its module-level main()
  // would run the confinement in-process if imported, and vitest's v8 coverage
  // never measures child processes. Its behavior is pinned end-to-end by
  // tests/runner.spec.ts, which spawns the real entry through tsx.
  const windowsRunnerCoverageExclusions = platform === 'win32'
    ? ['packages/sandbox/sandbox-windows-acl/src/runner.ts']
    : []

  // Linux-only sources: the libc execve binding is exercised through mocked
  // lazy-require suites that skip off Linux (linux-execve.spec.ts gates on
  // process.platform), so non-Linux coverage lanes can never cover them.
  const linuxOnlyCoverageExclusions = platform !== 'linux'
    ? ['packages/subprocess/subprocess-local/src/linux-execve.ts']
    : []

  // pwsh-local's run/start/lifecycle suites self-skip without a real pwsh
  // (executor.spec.ts hasPwsh), leaving this file
  // far below per-file 100% on pwsh-less hosts; the exemption keeps those hosts
  // green while CI runners ship pwsh and still enforce the full bar. The probe
  // runs the suites' own resolution (the dependency-free resolve.ts module),
  // so the exemption is active exactly when the suites skip — a mismatched
  // narrower probe could exempt the file on hosts whose suites actually run.
  const pwshCoverageExclusions = pwshAvailable
    ? []
    : [
      'packages/shell/pwsh-local/src/index.ts',
      'packages/shell/pwsh-sandbox/src/**/*.ts',
    ]

  return {
    include: ['packages/*/*/src/**/*.{ts,tsx}'],
    exclude: [
      'packages/*/*/src/types.ts',
      'packages/*/*/src/bin.ts',
      'packages/*/*/src/worker.ts',
      // The built Node entry invokes the independently covered process bootstrap through fd 7.
      'packages/ptc-runtime/ptc-runtime-node/src/process-entry.ts',
      // A killed executable lint-contract test can leave a non-product source probe behind.
      COVERAGE_LINT_PROBE,
      // Client/web UI files whose remaining branches need a browser-grade
      // harness the jsdom lane doesn't cover yet. TODO(gui): cover and
      // remove as the client test lane matures.
      'packages/client/ui-trajectory/src/*',
      // Trajectory's compact Markdown projection retains deferred branch coverage.
      'packages/client/ui-primitives/src/markdown/plain-text.ts',
      'packages/client/ui-user-questions/src/client/QuestionComposer.tsx',
      'packages/client/ui-primitives/src/Menu.tsx',
      'packages/client/ui-primitives/src/RiskConfirmation.tsx',
      'packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx',
      'packages/client/ui-workspace/src/client/WorkspacePicker.tsx',
      'packages/client/ui-renderer/src/client/*',
      // This isolated settings-scope lifecycle has complete unit coverage;
      // keep it out of the broader client-runtime GUI debt exemption.
      'packages/client/runtime/src/**/!(settings-scope).ts',
      // Keep the browser conversation tree under its existing GUI debt
      // exemption while gating the newly stateful Host half and vocabulary.
      'packages/client/ui-conversation/src/client/*',
      'packages/client/ui-conversation/src/invariant.ts',
      'packages/client/ui-primitives/src/DisclosureRow.tsx',
      'packages/client/ui-tool/src/*',
      'packages/client/ui-slots/src/*',
      'packages/client/ui-layout/src/*',
      'packages/client/web/src/*',
      'packages/host/webserver/src/*',
      'packages/client/modules/src/client/system.ts',
      'packages/client/hmr/src/client/index.ts',
      // Web config-tree boot round: the new host-side web-transport halves
      // whose remaining branches need real-composition/process harnesses.
      // TODO(gui): cover and remove with the client test lane above.
      'packages/client/modules/src/index.ts',
      'packages/client/modules/src/invariant.ts',
      'packages/client/modules/src/client/index.ts',
      'packages/client/modules/src/client/manifest.ts',
      'packages/client/hmr/src/index.ts',
      'packages/client/hmr/src/invariant.ts',
      'packages/client/connection/src/index.ts',
      'packages/client/connection/src/http-bridge.ts',
      // Account/project HTTP decoders are covered by their transport suites
      // and the assembled Gateway API checks; their malformed-wire branch
      // matrix is kept out of the browser GUI per-file gate until the wire
      // fuzz harness owns those cases.
      'packages/client/connection/src/client/account-preferences.ts',
      'packages/client/connection/src/client/project-models.ts',
      // Dynamic Host/Client composition is covered by its focused lifecycle
      // tests and assembled application checks rather than per-file coverage.
      'packages/self-modification/*/src/**/*.{ts,tsx}',
      // This assembly imports generated Host-for-Client code that exists
      // only in lib; the post-build built-bin smoke executes both entries.
      'packages/api/remotes/src/index.ts',
      'packages/api/remotes/src/client/index.ts',
      // Slash/command/input round: per-file gaps deferred with the same
      // client-lane debt. TODO(gui): cover and remove with the lane above.
      'packages/client/connection/src/client/fixture.ts',
      'packages/client/ui-commands/src/index.ts',
      'packages/client/ui-skill/src/index.ts',
      'packages/client/ui-input-trigger/src/index.ts',
      'packages/client/ui-subagent/src/index.ts',
      'packages/client/ui-commands/src/client/popup.ts',
      'packages/client/ui-commands/src/client/directory.ts',
      'packages/client/ui-commands/src/client/service.ts',
      'packages/client/ui-commands/src/client/PopupSelectView.tsx',
      'packages/client/ui-model-selection/src/index.ts',
      'packages/client/ui-permission-presets/src/index.ts',
      'packages/client/ui-model-selection/src/client/ModelSelect.tsx',
      'packages/client/ui-model-selection/src/client/directory.ts',
      'packages/client/ui-model-selection/src/client/index.ts',
      'packages/client/ui-model-selection/src/client/service.ts',
      'packages/client/ui-input-trigger/src/client/controller.ts',
      'packages/client/ui-input-trigger/src/client/service.ts',
      'packages/client/ui-input-trigger/src/core/menu.ts',
      'packages/client/ui-input-trigger/src/core/detect.ts',
      'packages/client/ui-sidebar/src/client/index.ts',
      'packages/client/ui-skill/src/client/index.ts',
      'packages/client/ui-workspace/src/client/index.ts',
      'packages/test-support/client-runtime/src/translate.ts',
      'packages/client/ui-primitives/src/JsonTree.tsx',
      'packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx',
      // The project bridge and management modal are exercised through the
      // focused project-store/component tests and the real Web flow. Their
      // transport-error and React event branches are intentionally outside
      // the per-file coverage gate, like the other browser-grade surfaces.
      'packages/client/ui-settings-models/src/client/project-store.ts',
      'packages/client/ui-collaboration/src/client/ProjectSettingsModal.tsx',
      'packages/extensions/*/src/**/*.ts',
      'packages/extensions/*/src/**/*.tsx',
      // Typert generator: correctness is pinned by its fixture suites and
      // the byte-for-byte catalog reproduction test; per-file coverage
      // would put whole-workspace compiler analysis under v8
      // instrumentation — the coverage lane's longest tail.
      'packages/typert/generator/src/*.ts',
      'packages/host/apiproxy/src/index.ts',
      'packages/host/apiproxy/src/api-proxy.ts',
      'packages/host/apiproxy/src/invariant.ts',
      // Projection/command round: executor lifecycle branches and the
      // registry's drive tails need the same maturing lanes. TODO(gui):
      // cover and remove with the client test lane above.
      'packages/interaction/commands/src/index.ts',
      'packages/interaction/commands/src/invariant.ts',
      'packages/session/session-projection/src/index.ts',
      // Debt the first hosted-runner coverage run reported, carried as an
      // explicit shrink-only roster (scripts/coverage-baseline.ts).
      ...coverageBaselineFiles,
      ...windowsUnsupportedCoveragePackages.map(path => `${path}/src/**/*.ts`),
      ...windowsOnlyCoverageExclusions,
      ...windowsRunnerCoverageExclusions,
      ...linuxOnlyCoverageExclusions,
      ...pwshCoverageExclusions,
    ],
    excludedTests: windowsUnsupportedTests,
  }
}

/** Resolve coverage using the same PowerShell availability as the executor suites.
 * @returns the current host's source policy.
 */
export function repositoryCoveragePolicy(): CoveragePolicy {
  const probe = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8', timeout: 15000 })
  if (probe.error !== undefined && 'code' in probe.error && probe.error.code === 'ETIMEDOUT') {
    throw new Error('coverage policy: PowerShell availability probe timed out')
  }
  const policy = resolveCoveragePolicy(process.platform, probe.status === 0)
  return { ...policy, exclude: [...policy.exclude, ...pureTypeCoverageSources(resolve(import.meta.dirname, '..'), policy)] }
}
