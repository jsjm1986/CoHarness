/**
 * Generate `upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-<tag>.json`: one row
 * per upstream changed-file area between the previously synced upstream tag
 * and the new target, with statuses, phases, and fork decisions derived from
 * `scripts/upstream-sync.json` plus the override tables below.
 *
 * `verify-upgrade-records` proves the emitted `cumulativeFiles` partition the
 * raw `git diff --no-renames` range exactly and that every carried-package
 * commit in the generated commit inventory is claimed by a row. Gate replay
 * inventories carry forward from the previous matrix, re-reviewing blobs that
 * changed at the new target.
 *
 * Usage: `pnpm run gen-upstream-alignment-matrix -- --tag dsh-v0.2.0-rc.1`
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadUpstreamSyncManifest, resolveTagCommit } from './verify-upstream-sovereignty.ts'

const root = resolve(import.meta.dirname, '..')
const ALIGNMENT_DIR = 'upgrades/alignment'

function fail(message: string): never {
  throw new Error(`gen-upstream-alignment-matrix: ${message}`)
}

function git(args: string[]): string {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.error !== undefined) fail(`git ${args.join(' ')} failed to spawn: ${run.error.message}`)
  if (run.status !== 0) fail(`git ${args.join(' ')} failed: ${run.stderr.trim()}`)
  return run.stdout
}

function gitBlob(commit: string, path: string): string | undefined {
  const run = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${commit}:${path}`], { encoding: 'utf8' })
  return run.status === 0 ? run.stdout.trim() : undefined
}

const PACKAGE_DIR = /^packages\/([0-9A-Za-z._-]+\/[0-9A-Za-z._-]+)\//

/** Package group → execution phase in upgrades/plans/UPGRADE-PLAN-dsh-v0.2.0-rc.1.md. */
const GROUP_PHASE: Record<string, string> = {
  llm: 'P3',
  core: 'P4', session: 'P4', jobs: 'P4', schedule: 'P4', context: 'P4',
  subprocess: 'P4', terminal: 'P4',
  api: 'P5', typert: 'P5', boot: 'P5', bundle: 'P5', settings: 'P5',
  preset: 'P5', credentials: 'P5', host: 'P5', interaction: 'P5',
  'self-modification': 'P5',
  client: 'P6',
  experimental: 'P8', acp: 'P8', subagent: 'P8', mcp: 'P8', hooks: 'P8',
  sdk: 'P9',
}

/** Package key → phase override when the group default is wrong. */
const PACKAGE_PHASE: Record<string, string> = {
  'llm/llm-deepseek-api-key': 'P3',
  'preset/agent-preset': 'P5',
  'preset/agent-preset-registry': 'P5',
  'skill/tool-workspace-dependencies': 'P1',
  'util/code-language': 'P1',
  'util/workspace-path': 'P1',
  'test-support/remote-mock': 'P1',
}

/** Non-package area prefix → phase. `apps/<name>` is keyed two levels deep. */
const AREA_PHASE: Record<string, string> = {
  'apps/web': 'P7', 'apps/cli': 'P7', 'apps/desktop': 'P7', 'apps/desktop-host': 'P7',
  'apps/android-shell': 'P7',
  vendor: 'P1', patches: 'P1', native: 'P1', scripts: 'P1', '.github': 'P1',
  'pnpm-lock.yaml': 'P1', 'pnpm-workspace.yaml': 'P1', 'package.json': 'P1',
  'tsconfig.base.json': 'P1', 'tsconfig.client.json': 'P1', 'tsconfig.host.json': 'P1',
  'tsdown.config.ts': 'P1', 'vitest.config.ts': 'P1', 'vitest.e2e.config.ts': 'P1',
  'vitest.snapshot.config.ts': 'P1', 'lefthook.yml': 'P1', Makefile: 'P1',
  benchmarks: 'P9', examples: 'P9', snapshots: 'P9', docs: 'P9', website: 'P9',
  '.agents': 'P9', python: 'P9',
}

/**
 * Per-area curation that cannot be derived mechanically: statuses, reject
 * reasons, assessments, and dispositions recording the locked owner decisions
 * for the dsh-v0.2.0-rc.1 round.
 */
const ROW_OVERRIDES: Record<string, Record<string, unknown>> = {
  'packages/session/session-format-v3-to-v4': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Same-key upstream package with unrelated semantics: CoHarness owns session-format-v3-to-v4 for the released v3→v4 edge, while upstream rc.1 uses the key for its V4-generation line. Recorded upstreamShadowed in scripts/upstream-sync.json. Upstream V4 event vocabulary (developer/message, forked, tool-role streaming, attachments, plugin:<name>) is absorbed event-by-event into the fork v6→v7 edge — never file-merged.',
    localDisposition: 'Owner decision: retain v6 generation; absorb upstream event semantics via a new adjacent v6→v7 migration edge in P4.',
  },
  'packages/session/tool-working-directory': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Same-key upstream package with divergent boundary semantics: upstream rc.2 dropped the "Directories must stay inside the project" constraint from the tool contract, while the fork-owned row keeps project-scoped admission. Recorded upstreamShadowed in scripts/upstream-sync.json.',
    localDisposition: 'Owner decision: retain the fork tool with project-boundary enforcement; do not adopt the upstream unbounded form.',
  },
  'packages/session/working-directory': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Same-key upstream package with divergent admission semantics: upstream rc.2 carries a minimal working-directory service, while the fork-owned row keeps admission policy, durable changes, and model context. Recorded upstreamShadowed in scripts/upstream-sync.json.',
    localDisposition: 'Owner decision: retain the fork service with admission policy; never file-merge with the upstream counterpart.',
  },
  'packages/experimental/schedule-bundle': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream deleted the in-place bundle and introduced schedule/tool-schedule under a different key; the fork retains the experimental bundle.',
    localDisposition: 'Owner decision: retain the experimental bundle; ui-schedule activates under experimental/schedule-bundle while schedule/tool-schedule carries the host-owned task store.',
  },
  'packages/hooks/hook-protocol': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/hook-protocol at rc.2.',
    localDisposition: 'Owner decision: follow the upstream demotion; the package lives at experimental/hook-protocol under its retained release name (EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS).',
  },
  'packages/hooks/hooks-claude-code': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/hooks-claude-code at rc.2.',
    localDisposition: 'Owner decision: follow the upstream demotion; the package lives at experimental/hooks-claude-code under its retained release name (EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS).',
  },
  'packages/hooks/hooks-codex': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/hooks-codex at rc.2.',
    localDisposition: 'Owner decision: follow the upstream demotion; the package lives at experimental/hooks-codex under its retained release name (EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS).',
  },
  'packages/runtime-diagnostics/invariants': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream deleted the package at rc.2 and removed its tsconfig/vitest aliases; the fork retains the implementation.',
    localDisposition: 'Owner decision: retain the implementation in place; upstream deleted the package entirely at rc.2.',
  },
  'packages/session-query/tool-session-query': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/tool-session-query at rc.2.',
    localDisposition: 'Owner decision: follow the upstream demotion; the package lives at experimental/tool-session-query under its retained release name (EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS).',
  },
  'packages/session/session-title-all-prompts-llm': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/session-title-all-prompts-llm at rc.2.',
    localDisposition: 'Owner decision: follow the upstream demotion; the package lives at experimental/session-title-all-prompts-llm under its retained release name (EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS).',
  },
  'packages/skill/skill-badge': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/skill-badge at rc.2.',
    localDisposition: 'Owner decision: retain in-place carriage; upstream deltas (icon, locale, metadata) were ported and the experimental duplicate removed.',
  },
  'packages/subagent/subagent-in-process-driver': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream deleted the package at rc.2; the fork retains the implementation.',
    localDisposition: 'Owner decision: retain the implementation in place; upstream deleted the package entirely at rc.2.',
  },
  'packages/terminal/tool-terminal': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/tool-terminal at rc.2.',
    localDisposition: 'Owner decision: retain in-place carriage; upstream deltas (icon, locale, metadata) were ported and the experimental duplicate removed.',
  },
  'packages/webhook/webhook': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/webhook at rc.2.',
    localDisposition: 'Owner decision: retain in-place carriage; upstream deltas (icon, locale, metadata) were ported and the experimental duplicate removed.',
  },
  'packages/webhook/webhook-github': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/webhook-github at rc.2.',
    localDisposition: 'Owner decision: retain in-place carriage; upstream deltas (icon, locale, metadata) were ported and the experimental duplicate removed.',
  },
  'packages/workflow/tool-ralph': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream moved the package to experimental/tool-ralph at rc.2.',
    localDisposition: 'Owner decision: retain in-place carriage; upstream deltas (icon, locale, metadata) were ported and the experimental duplicate removed.',
  },
  'packages/preset/agent-presets': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Owner decision: migrate to the upstream two-package structure (agent-preset + agent-preset-registry) in P5 while preserving derivePatches hooks, the Typert Remote contract, realm split, and the settings namespace. All consumers rewire in the same phase.',
  },
  'packages/preset/agent-preset': {
    status: 'required',
    targetAssessment: 'inherited-scope-review-required',
    localDisposition: 'Upstream preset payload half of the two-package split; carried in P5 with the registry, re-hung on the fork remote/authoring layer.',
  },
  'packages/preset/agent-preset-registry': {
    status: 'required',
    targetAssessment: 'inherited-scope-review-required',
    localDisposition: 'Upstream preset registry half of the two-package split (acquireScope/recompose/select + remoteExportList). Carried in P5; fork webhook/subagent/apiproxy consumers rewire onto it.',
  },
  'packages/settings/settings-file': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream removed packages/settings/settings-file between the baseline and rc.1; the fork-owned settings pipeline (settingsScope governance, owner/project-write semantics, settings.yaml) is retained as an owned package.',
    localDisposition: 'Owner decision: keep the fork settings model; selectively absorb upstream capabilities such as schema projection without moving governance.',
  },
  'packages/client/ui-settings-unarchive-sessions': {
    status: 'reject',
    targetAssessment: 'fork-owned',
    rejectReason: 'Upstream removed the package between the baseline and rc.1; the fork-owned archive surface is retained.',
  },
  'packages/experimental/agent-team-web-profile': {
    status: 'reject',
    targetAssessment: 'not-carried',
    rejectReason: 'Upstream removed the package between the baseline and rc.1 and folded its Web UI mount into agent-team-profile; the fork followed the fold and removed its copy.',
  },

  'packages/api/job-controller': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Owner decision: adopt upstream ring-buffer job output (JobChunk, lossy semantics, spillPath, owner: SessionId, read-only JobView) and fold the remote surface into host/apiproxy in P4 — no standalone upstream job-controller package.',
  },
  'packages/jobs/jobs': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Owner decision: ring-buffer output rewrite adopted (JobChunk/lossy/spillPath/owner: SessionId/JobView) as an independent P4 milestone touching durable semantics, wire protocol, completion reporting, and bounded reads. maxConsecutiveWakes stays bounded at 10 per the multi-tenant safety decision — never unbounded.',
  },
  'packages/client/ui-schedule': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Host-owned task store carried: the conversational-delivery decision was superseded and archived at .agents/notes/archived/simplification/2026-08-09-conversational-schedule-delivery.md. ui-schedule is resident in the shipped web-app patch and activates under experimental/schedule-bundle; browser projections run on ClientSessionKey — catalog rows keyed via ctx.sessions.keyFor, Remote calls decode back to raw Host ids (see .agents/notes/implemented/bug-fix/2026-10-03-schedule-catalog-session-identity.md).',
  },
  'packages/schedule/schedule': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Host-owned task store carried byte-identical to rc.2 except type-only import rewrites onto the fork api/remotes session-controller. storage.ts/delivery-history.ts/update.ts own active and ended tasks; historical schedule/change events decode as LegacyScheduleRecord without implicit migration.',
  },
  'packages/client/connection': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Transport fork retained: the client uses the apiproxy JSON envelope plus readRpcStream/dshTarget routing rather than upstream\'s multipart/binary response parser and worker-local stream uplink. browser-auth is carried with the fork-specific exemption that authority:\'loopback\' handlePrefix subtrees (webhook/gateway machine callers) keep the request-trust fence without cookie auth.',
  },
  'packages/client/store': {
    status: 'reject',
    targetAssessment: 'not-carried',
    rejectReason: 'Upstream snapshot-store package duplicates client/runtime exports (createSnapshotStore/defineStore/shallowEqual). Owner decision: import remapping to client/runtime — no dual client state source.',
    localDisposition: 'Adopted package imports are rewritten to client/runtime in P6.',
  },
  'packages/telemetry/otel': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Fork retains its self-contained session-telemetry-otel implementation (DISABLED by default, fork-owned endpoints); the upstream byte-bounded batching processor is ported onto it.',
  },
  'packages/test-support/acp-snapshot': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Fork-owned test-support package previously unmanifested; registered at rc.1 and reconciled with upstream test-support changes.',
  },

  'non-package:apps/web': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Owner decision: full commit-intent audit (184 fix commits classified in upgrades/alignment/UPSTREAM-FIX-AUDIT-CLIENT-dsh-v0.2.0-rc.1.md); per-bug reproduce-or-refute against the rewritten local shell in P7.',
  },
  'non-package:apps/cli': {
    status: 'adapt',
    targetAssessment: 'increment-review-required',
    localDisposition: 'Owner decision: full commit-intent audit, same rigor as apps/web — cli is a snapshot/e2e carrier even though the product is Web-first.',
  },
  'non-package:apps/desktop': {
    status: 'reject',
    targetAssessment: 'not-carried',
    rejectReason: 'Upstream desktop client application; CoHarness ships the Web product plus CLI and Android shells and never carried apps/desktop or apps/desktop-host. Shared startup interfaces are reviewed through the apps/cli row. Upstream desktop lanes moved to scripts/primary-runtime are re-examined under non-package:scripts.',
  },
  'non-package:apps/desktop-host': {
    status: 'reject',
    targetAssessment: 'not-carried',
    rejectReason: 'Upstream desktop host process; CoHarness ships the Web product plus CLI and Android shells and never carried apps/desktop or apps/desktop-host.',
  },
}

/**
 * Rows for upstream packages that left no net file change in the range —
 * created and deleted between the endpoints — whose commits still land in the
 * `newUpstream` inventory bucket and need an explicit claim.
 */
const GHOSTS = JSON.parse(
  readFileSync(resolve(root, ALIGNMENT_DIR, 'GHOST-UPSTREAM-COMMITS.json'), 'utf8'),
) as {
  ghosts: Record<string, { upstreamCommits: string[]; rejectReason: string; notes: string }>
}

const EXTRA_ROWS: Record<string, unknown>[] = Object.entries(GHOSTS.ghosts).map(([area, ghost]) => ({
  area,
  status: 'reject',
  localOwner: area,
  upstreamCommits: ghost.upstreamCommits,
  reviewState: 'implemented-local-tests-passing',
  phase: 'P2',
  phaseAssignment: 'cross-audit-dsh-v0.2.0-rc.1',
  targetAssessment: 'not-carried',
  rejectReason: ghost.rejectReason,
  cumulativeFiles: [],
  notes: ghost.notes,
}))

/** Upstream-only keys promoted to carry-ins rather than rejections. */
const CARRY_IN = new Set([
  'api/job-controller', // adapt — ring rewrite folded into apiproxy (row override)
  'llm/llm-deepseek-api-key',
  'preset/agent-preset',
  'preset/agent-preset-registry',
  'skill/tool-workspace-dependencies',
  'util/code-language',
  'util/workspace-path',
  'test-support/remote-mock',
])

/** Gate-replay contract updates where upstream changed the reviewed input at rc.1. */
const REPLAY_UPDATES: Record<string, string> = {
  'scripts/prepare-ci-bubblewrap.sh': 'Preserve pinned-payload SHA-256 verification and the functional confinement probe; rc.1 moves the pin to bubblewrap 0.12.0-1 with a Launchpad build URL that survives Ubuntu pool pruning (glibc 2.38+/Linux 5.10+, satisfied by the 24.04 image).',
  'scripts/run-web-snapshots.ts': 'Retain the serial-owner list (rc.1 adds client-plugin-live.e2e.ts) and the bounded worker pool; rc.1 relaxes DSH_WEB_SNAPSHOT_WORKERS to a positive integer so a single worker is legal.',
  'apps/web/tests/scaffold-hermetic.e2e.ts': 'Hermetic scaffold assertions; rc.1 tracks the agent-presets→agent-preset-registry rename.',
  'apps/web/tests/markdown-cjk-strong.e2e.ts': 'CJK strong-emphasis golden; rc.1 switches to shared WEB_FIXTURE_TIME determinism with clock.setFixedTime and seedSession createdAt.',
  '.github/workflows/python-release.yml': 'Keep independent family build/pack jobs, explicit evidence_runs on publication, pack-hash capture, and preflight/publication authentication; rc.2 only bumps action pins (checkout v7.0.1, artifact actions *.0.1) with no semantic change.',
  '.github/workflows/build-exe-for-python-sdk.yml': 'Keep the plan → sdk-wheel → matrix build shape and artifact retention; runner sizing remains upstream-infrastructure specific. rc.2 routes release macOS legs to macos-15-large/xlarge runners, bumps action pins, and disables verifyDepsBeforeRun on the addon install so node-gyp is not packaged into the exe.',
  '.github/workflows/ci.yml': 'Keep aggregate gate ordering and fork lanes; rc.2 bumps action pins, adds a coverage duration-history cache (restore/save around the coverage lane), raises the static timeout to 20m, and drops the data-disk note reference from the /tmp comment.',
  '.github/workflows/e2e.yml': 'Keep canonical-repo and secret preflight, dispatch gating, JSON results, real-provider assertions, and the Office runtime prepare step (DSH_PRIMARY_RUNTIME); rc.2 bumps action pins and runs `build:artifacts --profile official` on pull_request legs while keeping `build:official` elsewhere.',
  '.github/workflows/release-vendor.yml': 'Keep vendored artifact build/publish ordering; rc.2 bumps action pins and compiles host libraries via `compile-referenced-projects host-libraries` on pull_request legs instead of the full `build:lib:host`.',
  '.github/workflows/release.yml': 'Keep release shape and artifact retention; rc.2 bumps action pins and runs `build:artifacts --profile official` on pull_request legs instead of `build:official`.',
  '.github/workflows/sandbox.yml': 'Resolve native build commands against native/system and preserve real-kernel confinement assertions, the anti-self-skip guard, and exit-status propagation; rc.2 bumps action pins and runs the unit lane through `check:ci:unit` with `DSH_COVERAGE_TEST_TIMEOUT_MS=90000` for shared-runner contention.',
  '.github/workflows/pi-ai-provider-e2e.yml': 'Keep the pi-ai real-provider lane as wired; rc.2 only bumps action pins (checkout v7.0.1, pnpm v5.0.0, setup-node v7.0.0).',
  'apps/web/tests/scaffold.ts': 'Keep real Loader and storage lifecycle, explicit userdoc-local uploadRoot, the auth scaffold, and package.json dsh.bundle.patch bundle loading; rc.2 switches the JSONL persistence import to a namespace, adds workspacePathLength compaction pinning, drops the `both` toolsMode, makes baseURL optional, and adds a deepSeekWebApi deterministic search/fetch override lane.',
  'apps/web/tests/queue-actions.e2e.ts': 'Keep queue ordering, edit-queued-message semantics, and tooltip-on-top geometry coverage, pruning shortcut-coupled assertions; rc.2 adds a goal-stop scenario that drives a queued Goal round through a replay-override hang file (`.round-ready`/`.human-ready` sentinel files).',
  'apps/web/tests/workspace-management.e2e.ts': 'Keep scope-archive assertions and directory-browser goldens; the stale-blank-cache New Session regression stays a pending port onto the local session runtime API. rc.2 drops the SessionLogOffset import, parameterizes seededSessionRow by page, renames the settings hover to `Account menu`, and adds a tooltips-above-card geometry case.',
  'package.json': 'Keep fork command names wired to existing executor modes; rc.2 bumps version to 0.2.1-rc.2 and pnpm to 11.28.5, adds `build:artifacts`/`build:check` build scopes, and passes `--config-loader native` to tsdown benches and host libs.',
  'python/sdk/pyproject.toml': 'Keep hatchling pin and test extras shape; rc.2 bumps hatchling to 1.32.0, adds Pillow to the test extra, and pins core-metadata-version 2.4 for Twine 6.2.0.',
  'python/sdk/uv.lock': 'Regenerated lockfile matching the pyproject bump (hatchling 1.32.0, Pillow test extra); carry the lockfile wholesale with the manifest.',
  'scripts/release/publish.ts': 'Keep packed-order publication and tarball identity checks; rc.2 adds dist-tag validation (reject empty/`-`-prefixed/URI-unsafe/range tags) and verifies `npm dist-tag ls` state before mutating an explicit channel.',
  'scripts/run-gates.ts': 'Keep three-state gates, needs/after semantics, existing source leaves, evidence, and hygiene union with build deduplication; acl-skill.built remains a desktop lane pruned at carry. rc.2 adds a `ci-unit` mode, exports `ConcurrencyDefault`, splits worker budgeting into scripts/parallelism.ts (LOCAL_TEST_PARALLELISM_CAP/defaultParallelism), and moves coverage timeout handling out of coverage-partitions.',
  'scripts/run-gates.spec.ts': 'Keep gate-graph assertions and env stubbing so fixtures own the browser pool; rc.2 stubs DSH_COVERAGE_MAX_WORKERS/DSH_COVERAGE_PARTITIONS in beforeEach, adds platform/node-version mutation helpers (worker-global, synchronous use only), and threads an onOutput observer through captureStreamedOutput.',
  'scripts/run-oxlint.ts': 'Keep DSH_OXLINT_THREADS override semantics; rc.2 takes a cpus parameter, keeps Oxlint defaults under CI=true, and bounds local runs by defaultParallelism with GOMAXPROCS propagated.',
  'scripts/run-oxlint.spec.ts': 'Keep override/error coverage; rc.2 asserts CI keeps Oxlint defaults, local runs are bounded by the worker budget, and a caller `--threads` passes through.',
  'scripts/publish-npm-baseline.ts': 'Keep tarball manifest inspection and publish-baseline assertions; rc.2 drops the `verify-built-package-invariants` invocation from the publish lane.',
  'scripts/gen-third-party-notices.ts': 'Keep Ruff MIT metadata, vendor/AGENTS coverage, and generated-artifact assertions; prune desktop-lane references. rc.2 adds the experimental Inspector chrome-devtools-frontend BSD-3-Clause disclosure and repoints the LibreOffice kit URL to deepseek-ai/dsh-libreoffice-kit.',
  'scripts/coverage-partitions.ts': 'Keep single-worker partition scheduling and merged-threshold semantics; rc.2 moves timeout flags to `coverageTestTimeoutOptions` (values, not argv), adds a file-times reporter hook, and keeps the separate-process isolation rationale.',
  'tsconfig.base.json': 'Keep single-source path aliases per package/vendor boundary; excluded-lane aliases are pruned at carry. rc.2 adds experimental alias rows (session-search, ralph/terminal/badge/session-titles bundles, translator, cot-translation pair, claude-code-mods incl. examples/* subpath, cua + cua-macos), adds api/remote-access + typert remote-info, and removes the invariants/session-invariant aliases.',
  'vitest.config.ts': 'Keep lane partitioning and shared-host serial semantics, and prune coverage exclusions for lanes the fork does not carry. rc.2 moves hooks packages to experimental paths under coverage exclusions, excludes cua-macos shared-native, routes per-test budgets through coverageTestTimeoutOptions (DSH_COVERAGE_TEST_TIMEOUT_MS), caps local workers via parallelism.ts, adds claude-code-mods testing aliases, and drops test-invariants from setupFiles.',
}

/** Area key for a changed path: packages keep two segments; other dirs keep one; files keep the full name. */
function areaOf(path: string): { area: string; scope: string } {
  const pkg = PACKAGE_DIR.exec(path)
  if (pkg !== null) return { area: `packages/${pkg[1]}`, scope: `packages/${pkg[1]}/` }
  const slash = path.indexOf('/')
  const top = slash === -1 ? path : path.slice(0, slash)
  const two = slash === -1 ? top : path.split('/').slice(0, 2).join('/')
  const key = top === 'apps' ? two : top
  return { area: `non-package:${key}`, scope: slash === -1 || top === key ? (top === key && slash !== -1 ? `${key}/` : key) : `${key}/` }
}

function main(args: string[]): number {
  const tagIndex = args.indexOf('--tag')
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined
  if (tag === undefined || tag.startsWith('--')) fail('usage: gen-upstream-alignment-matrix -- --tag <newTag>')
  const manifest = loadUpstreamSyncManifest(root)
  const target = resolveTagCommit(root, tag)
  if (target === null) fail(`tag "${tag}" is not fetched locally`)
  if (manifest.syncedCommit !== target) fail(`manifest syncedCommit ${manifest.syncedCommit} does not match tag ${tag} (${target})`)

  // The baseline is the previous matrix's target — the last synced upstream.
  const prior = readdirSync(resolve(root, ALIGNMENT_DIR))
    .filter(name => name.startsWith('UPSTREAM-ALIGNMENT-MATRIX-') && name.endsWith('.json'))
    .map(name => ({ name, parsed: JSON.parse(readFileSync(resolve(root, ALIGNMENT_DIR, name), 'utf8')) as { target?: { tag?: string; commit?: string } } }))
    .filter(item => item.parsed.target?.commit !== undefined && item.parsed.target.commit !== target)
    .sort((a, b) => a.name.localeCompare(b.name))
  const baselineRecord = prior.at(-1)
  if (baselineRecord === undefined) fail('no prior alignment matrix to derive the baseline from')
  const baseline = { tag: String(baselineRecord.parsed.target?.tag), commit: String(baselineRecord.parsed.target?.commit) }

  const changed = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseline.commit, target, '--'])
    .split('\0').filter(Boolean)

  const buckets = new Map<string, { scope: string; files: string[] }>()
  for (const file of changed) {
    const { area, scope } = areaOf(file)
    const bucket = buckets.get(area) ?? { scope, files: [] }
    bucket.files.push(file)
    buckets.set(area, bucket)
  }

  // Content comparison sets for per-area notes.
  const rc1Files = new Set(git(['ls-tree', '-r', '--name-only', target]).split('\n').filter(Boolean))
  const headFiles = new Set(git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean))
  const differing = new Set(git(['diff', '--no-renames', '--name-only', '-z', target, 'HEAD', '--']).split('\0').filter(Boolean))

  const upstreamOnlyReason = new Map(manifest.upstreamOnly.map(item => [item.package, item.reason]))

  const priorRows = new Map<string, { reviewState?: string }>()
  if (Array.isArray((baselineRecord.parsed as { rows?: unknown[] }).rows)) {
    for (const row of (baselineRecord.parsed as { rows: Record<string, unknown>[] }).rows) {
      if (typeof row.area === 'string' && typeof row.reviewState === 'string') priorRows.set(row.area, { reviewState: row.reviewState })
    }
  }

  const rows: Record<string, unknown>[] = []
  for (const [area, bucket] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const files = bucket.files.sort()
    const pkgKey = area.startsWith('packages/') ? area.slice('packages/'.length) : undefined
    const sovereignty = pkgKey === undefined ? undefined : manifest.packages[pkgKey]?.sovereignty
    const upstreamOnly = pkgKey !== undefined && manifest.packages[pkgKey] === undefined
      ? upstreamOnlyReason.get(pkgKey) : undefined
    const override = ROW_OVERRIDES[area] ?? {}

    const group = pkgKey?.split('/')[0]
    const phase = (override.phase as string | undefined)
      ?? (pkgKey !== undefined ? PACKAGE_PHASE[pkgKey] ?? GROUP_PHASE[group ?? ''] ?? 'P2'
        : AREA_PHASE[area.slice('non-package:'.length)] ?? 'P9')

    let status: string
    let targetAssessment: string
    let reviewState: string
    if (typeof override.status === 'string') {
      status = override.status
      targetAssessment = String(override.targetAssessment)
      reviewState = status === 'reject' ? 'implemented-local-tests-passing' : 'pending-cumulative-source-review'
    } else if (sovereignty === 'tracked') {
      status = 'retain'; targetAssessment = 'increment-review-required'; reviewState = 'pending-cumulative-source-review'
    } else if (sovereignty === 'adapted' || sovereignty === 'replaced' || sovereignty === undefined) {
      if (sovereignty === undefined && upstreamOnly !== undefined) {
        const deferred = /defer/i.test(upstreamOnly)
        const carried = CARRY_IN.has(pkgKey ?? '')
        status = carried ? 'required' : deferred ? 'defer' : 'reject'
        targetAssessment = carried ? 'inherited-scope-review-required' : deferred ? 'deferred-this-release' : 'not-carried'
        reviewState = carried ? 'pending-cumulative-source-review' : deferred ? 'deferred-platform-review' : 'implemented-local-tests-passing'
      } else if (sovereignty === undefined && pkgKey !== undefined && !rc1Files.has(`packages/${pkgKey}/package.json`)) {
        // Local package upstream never had but the key sits inside the diff range
        // via a deleted sibling — cannot happen; guard anyway.
        status = 'reject'; targetAssessment = 'not-carried'; reviewState = 'implemented-local-tests-passing'
      } else if (sovereignty === undefined && pkgKey !== undefined) {
        // Upstream package with no manifest entry and no upstreamOnly reason — should be unreachable.
        status = 'reject'; targetAssessment = 'not-carried'; reviewState = 'pending-cumulative-source-review'
      } else {
        status = 'adapt'; targetAssessment = 'increment-review-required'; reviewState = 'pending-cumulative-source-review'
      }
    } else {
      // sovereignty === 'owned' is the only remaining value.
      const shadowed = manifest.packages[pkgKey ?? '']?.upstreamShadowed === true
      const stillUpstream = rc1Files.has(`packages/${pkgKey}/package.json`)
      status = 'reject'; targetAssessment = 'not-carried'; reviewState = 'implemented-local-tests-passing'
      if (!shadowed) {
        override.rejectReason = stillUpstream
          ? `Fork-owned package; upstream packages/${pkgKey} changes do not apply.`
          : `Upstream removed packages/${pkgKey} between ${baseline.tag} and ${tag}; the fork-owned package is retained.`
      }
    }

    // Per-area change statistics against the target.
    const prefix = bucket.scope
    const upstreamUnderPrefix = [...rc1Files].filter(f => f.startsWith(prefix) || f === prefix.replace(/\/$/, ''))
    const identical = upstreamUnderPrefix.filter(f => headFiles.has(f) && !differing.has(f)).length
    const localDiffs = upstreamUnderPrefix.filter(f => headFiles.has(f) && differing.has(f)).length
    const notCarried = upstreamUnderPrefix.filter(f => !headFiles.has(f)).length
    const upstreamDeleted = files.filter(f => !rc1Files.has(f)).length
    const stats = `${String(identical)}/${String(upstreamUnderPrefix.length)} target files byte-identical locally; ${String(localDiffs)} carry fork diffs; ${String(notCarried)} not carried; ${String(upstreamDeleted)} removed upstream this round`

    const row: Record<string, unknown> = {
      area,
      status,
      localOwner: area.replace(/^non-package:/, ''),
      commitScope: [bucket.scope],
      reviewState,
      phase,
      phaseAssignment: `cross-audit-${tag}`,
      targetAssessment,
      cumulativeFiles: files,
    }
    if (sovereignty !== undefined) row.localSovereignty = sovereignty
    if (upstreamOnly !== undefined) {
      row.localSovereignty = 'upstreamOnly'
      row.upstreamOnly = { reason: upstreamOnly }
      if (status === 'reject') row.rejectReason = upstreamOnly
    }
    if (typeof override.rejectReason === 'string') row.rejectReason = override.rejectReason
    if (typeof override.localDisposition === 'string') row.localDisposition = override.localDisposition
    if (priorRows.has(area)) {
      row.alpha2History = {
        record: `${ALIGNMENT_DIR}/${baselineRecord.name}`,
        area,
        reviewState: priorRows.get(area)?.reviewState,
      }
    }
    if (status === 'reject' && row.rejectReason === undefined) {
      row.rejectReason = sovereignty === 'owned' ? String(override.rejectReason) : 'Rejected upstream surface; recorded in the sovereignty manifest.'
    }
    if (targetAssessment === 'increment-review-required' || targetAssessment === 'inherited-scope-review-required') {
      row.localPlan = `${phase} per upgrades/plans/UPGRADE-PLAN-${tag}.md`
    }
    row.notes = typeof override.notes === 'string'
      ? override.notes
      : `Cumulative ${baseline.tag}→${tag} review ${new Date().toISOString().slice(0, 10)}: ${stats}.`
    rows.push(row)
  }
  for (const extra of EXTRA_ROWS) rows.push(extra)

  // Carry gate replays forward; re-review changed blobs at the new target.
  const priorReplays: Record<string, unknown>[] = []
  if (Array.isArray((baselineRecord.parsed as { rows?: unknown[] }).rows)) {
    for (const row of (baselineRecord.parsed as { rows: Record<string, unknown>[] }).rows) {
      if (Array.isArray(row.gateReplays)) priorReplays.push(...(row.gateReplays as Record<string, unknown>[]))
    }
  }
  let replayAttached = 0
  for (const replay of priorReplays) {
    const path = String(replay.path)
    const blob = gitBlob(target, path)
    if (blob === undefined) fail(`gate replay ${path} no longer exists at ${tag}`)
    const changedBlob = blob !== String(replay.upstreamBlob)
    const next: Record<string, unknown> = {
      ...replay,
      upstreamBlob: blob,
      reviewedUpstreamCommit: changedBlob ? target : replay.reviewedUpstreamCommit,
      ...(REPLAY_UPDATES[path] !== undefined ? { replay: REPLAY_UPDATES[path] } : {}),
    }
    if (changedBlob && REPLAY_UPDATES[path] === undefined) fail(`gate replay ${path} changed upstream without a recorded re-review note`)
    for (const ref of [path, ...(next.regressions as string[])]) {
      if (!existsSync(resolve(root, ref))) fail(`gate replay ${path} references missing local path ${ref}`)
    }
    const { area } = areaOf(path)
    const owner = rows.find(r => r.area === area)
    if (owner === undefined) fail(`gate replay ${path} has no owning area row`)
    const list = (owner.gateReplays ??= []) as unknown[]
    list.push(next)
    replayAttached += 1
  }

  const out = {
    schemaVersion: 3,
    reviewDate: new Date().toISOString().slice(0, 10),
    baseline,
    target: { tag, commit: target },
    inventoryMethod: 'Raw cumulative path inventory reproduces git diff --no-renames --name-only -z between the recorded Git commits. Every changed path has exactly one row owner. Gate replay blobs are re-reviewed at the target; unchanged inputs carry forward under the ancestor rule.',
    summary: { cumulativeChangedFiles: changed.length, rows: rows.length },
    rows,
  }
  const file = resolve(root, ALIGNMENT_DIR, `UPSTREAM-ALIGNMENT-MATRIX-${tag}.json`)
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`gen-upstream-alignment-matrix: wrote ${ALIGNMENT_DIR}/UPSTREAM-ALIGNMENT-MATRIX-${tag}.json — ${String(rows.length)} rows, ${String(changed.length)} cumulative files, ${String(replayAttached)} gate replays.`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('gen-upstream-alignment-matrix:') ? message : `gen-upstream-alignment-matrix: ${message}`)
    process.exitCode = 1
  }
}
