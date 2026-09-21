import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'
import { COVERAGE_EXEMPT_ENV, coverageExemptHeavySuites } from './scripts/coverage-exempt.ts'
import { COVERAGE_PARTITION_MODE_ENV } from './scripts/coverage-partitions.ts'
import { COVERAGE_SCOPED_MODE_ENV } from './scripts/coverage-scoped.ts'
import { probePwshAvailable, repositoryCoveragePolicy, repositoryTestExclusions, resolveCoveragePolicy, type CoveragePolicy } from './scripts/coverage-policy.ts'

// Prints exact `path:line:col` records for every uncovered statement, branch
// path, and function when a file misses the per-file 100% gate — the built-in
// threshold ERRORs name only the file. Absolute path because istanbul-reports
// require()s custom reporters (which is also why the reporter is CJS).
const uncoveredLocationsReporter = fileURLToPath(new URL('./scripts/coverage-uncovered-locations.cjs', import.meta.url))

// Resolution facade shared by every plugin instance below: tsconfig.base.json
// has no include, which vite-tsconfig-paths treats as match-all, so its paths
// map applies to every test file. paths must win over package exports so built
// lib/ never loads a second module-singleton copy.
const pathsPlugin = (): ReturnType<typeof tsconfigPaths> => tsconfigPaths({ projects: ['./tsconfig.base.json'] })

// Plain test runs need only the platform test exclusions; the pure-type
// source scan is a coverage-lane concern and stays lazy (see below).
const windowsUnsupportedTests = [...repositoryTestExclusions()]

const testIncludes = [
  'packages/*/*/tests/**/*.spec.{ts,tsx}',
  'apps/*/tests/**/*.spec.ts',
  'examples/*/tests/**/*.spec.ts',
  'scripts/**/*.spec.ts',
  'website/tests/**/*.spec.ts',
]

// The instrumented coverage gate sets this env; the exempt heavy suites then
// run beside it uninstrumented (membership contract in scripts/coverage-exempt.ts).
// A set-but-not-'1' value is a misconfiguration, not a silent no-op.
const coverageExemptRaw = process.env[COVERAGE_EXEMPT_ENV]
if (coverageExemptRaw !== undefined && coverageExemptRaw !== '' && coverageExemptRaw !== '1') {
  throw new Error(`vitest config: ${COVERAGE_EXEMPT_ENV} must be '1' or unset, got ${JSON.stringify(coverageExemptRaw)}.`)
}
const coverageExemptExcludes = coverageExemptRaw === '1'
  ? coverageExemptHeavySuites.map(suite => suite.exclude)
  : []

// The pure-type exclusion scan reads every measured source; derive the full
// source policy only when this invocation actually collects coverage.
const coverageRequested = process.argv.some(arg => arg === '--coverage' || arg.startsWith('--coverage.'))
  || process.env[COVERAGE_PARTITION_MODE_ENV] === '1'
  || process.env[COVERAGE_SCOPED_MODE_ENV] === '1'
let memoizedCoveragePolicy: CoveragePolicy | undefined
const coveragePolicy = (): CoveragePolicy => coverageRequested
  ? memoizedCoveragePolicy ??= repositoryCoveragePolicy()
  : resolveCoveragePolicy(process.platform, probePwshAvailable())

const coveragePartitionRaw = process.env[COVERAGE_PARTITION_MODE_ENV]
if (coveragePartitionRaw !== undefined && coveragePartitionRaw !== '' && coveragePartitionRaw !== '1') {
  throw new Error(`vitest config: ${COVERAGE_PARTITION_MODE_ENV} must be '1' or unset, got ${JSON.stringify(coveragePartitionRaw)}.`)
}
const coveragePartitionMode = coveragePartitionRaw === '1'

// The scoped changed-package lane runs the changed packages' tests only. Its
// per-file 100% thresholds are enforced by scripts/incremental-coverage.ts over
// the produced coverage map, so the global per-file threshold would reject
// packages outside the changed set that those tests import without fully
// exercising. Uncapping here keeps the intermediate vitest run green; the
// incremental gate owns the authoritative verdict.
const coverageScopedRaw = process.env[COVERAGE_SCOPED_MODE_ENV]
if (coverageScopedRaw !== undefined && coverageScopedRaw !== '' && coverageScopedRaw !== '1') {
  throw new Error(`vitest config: ${COVERAGE_SCOPED_MODE_ENV} must be '1' or unset, got ${JSON.stringify(coverageScopedRaw)}.`)
}
const coverageScopedMode = coverageScopedRaw === '1'

// These suites exercise process-global state, process APIs, or timing-sensitive process I/O
// that worker threads cannot isolate reliably under aggregate gate contention.
// Keep the narrow exception in forks while the rest of the inventory avoids per-file processes.
const processBoundTests = [
  'packages/session/session-persistence-jsonl/tests/jsonl.spec.ts',
  'packages/subagent/subagent-acp/tests/subagent-acp.spec.ts',
  'packages/subprocess/subprocess-local/tests/process-exit.spec.ts',
  'packages/subprocess/subprocess-local/tests/spawn.spec.ts',
  'packages/context/time-context/tests/time-context.spec.ts',
  'packages/llm/llm-pi-ai/tests/adapter.spec.ts',
  'packages/boot/app-boot/tests/app-boot.spec.ts',
  'packages/workflow/workflow-ptc/tests/session.spec.ts',
]

export default defineConfig({
  plugins: [pathsPlugin(), standardDecoratorPlugin()],
  test: {
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-invariants.ts'],
    // .tsx: client component specs (jsdom via per-file @vitest-environment pragma).
    include: testIncludes,
    exclude: windowsUnsupportedTests,
    // One coverage invocation aggregates both projects. Every suite forks for
    // Node stability; process-bound suites stay separate for inventory control.
    projects: [
      {
        plugins: [pathsPlugin(), standardDecoratorPlugin()],
        test: {
          name: 'thread-safe',
          execArgv: vitestExecArgv,
          // Node 24 has aborted in its CJS lexer (v8::ToLocalChecked Empty
          // MaybeLocal in cjs_lexer::Parse) from worker threads on macOS,
          // Linux, and Windows. Forked workers avoid that shared thread path.
          pool: 'forks',
          setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-invariants.ts'],
          include: testIncludes,
          exclude: [
            ...windowsUnsupportedTests,
            ...processBoundTests,
            ...coverageExemptExcludes,
          ],
        },
      },
      {
        plugins: [pathsPlugin(), standardDecoratorPlugin()],
        test: {
          name: 'process-bound',
          execArgv: vitestExecArgv,
          pool: 'forks',
          setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-invariants.ts'],
          include: processBoundTests,
          exclude: [
            ...windowsUnsupportedTests,
            ...coverageExemptExcludes,
          ],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Coverage measures OUR runtime source. Types-only files carry no
      // executable code; vendor/ and examples/ are out of scope (examples are
      // exercised by the demo smoke test instead).
      // .tsx: client components are gated like everything else (jsdom lane).
      include: [...coveragePolicy().include],
      // Types-only files have no runtime coverage. Importing self-executing bins/workers would boot
      // them inside the unit process, so real subprocess/Worker tests cover their thin entry glue.
      exclude: [...coveragePolicy().exclude],
      // 100% or it doesn't merge (docs/testing.md: excessive tests are welcome).
      // Per-file so a well-covered big file can't subsidize a bare one.
      // Every v8 ignore comment must carry a reason — see the quality-gates Agent Note
      // (.agents/notes/implemented/process/2026-06-11-quality-gates.md).
      thresholds: coveragePartitionMode || coverageScopedMode
        ? undefined
        : {
            perFile: true,
            statements: 100,
            branches: 100,
            functions: 100,
            lines: 100,
          },
      reporter: coveragePartitionMode
        ? []
        : process.env.CI
          ? ['text', uncoveredLocationsReporter]
          : ['text', 'html', uncoveredLocationsReporter],
    },
  },
})
