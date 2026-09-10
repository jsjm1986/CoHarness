# Agent Note: Incremental CI lane gating

Status: implemented

English | [中文](2026-09-10-incremental-ci-lane-gating.zh.md)

## Problem

Every pull request that touched source or dependency files ran the complete expensive lane set: full coverage, the full consumer inventory including Playwright browser snapshots, the release-shaped Python runtime, and both Windows signals. A one-file package change paid the same wall clock as a repository-wide rewrite, so routine changes spent tens of minutes on surfaces they could not affect.

## Decision

The pull-request scope classifier now selects a `scoped` lane for changes that are purely package source and test files. A PR qualifies when every changed path is a `.ts`/`.tsx` under `packages/<group>/<pkg>/src/` or `packages/<group>/<pkg>/tests/`, and the number of distinct changed packages is at most `MAX_SCOPED_PACKAGES` (4). Anything else — dependencies, lockfiles, infrastructure scripts, apps, docs, or a larger package set — stays on the existing `full` lane.

Two lightweight aggregates were added to the gate runner:

- `ci-coverage-scoped` runs Vitest coverage for the changed packages' test directories only, then enforces the authoritative per-file 100% gate with `scripts/incremental-coverage.ts` over the produced map. The global per-file threshold is disabled during the intermediate Vitest run (`DSH_COVERAGE_SCOPED_MODE=1`) because the selected tests import unchanged packages they never fully exercise; the incremental gate owns the verdict for exactly the changed files.
- `ci-consumers-scoped` is the complete consumer inventory minus the Playwright web-snapshot gate. Keyless ACP/CLI snapshots, lint, publint, built invariants, doc-typecheck, node-next-types, and built-bin smoke all still run; only the browser-grade snapshot is dropped.

The workflow uses the existing `run_expensive` selector for the coverage and consumer jobs (both lanes run them) and gates `python-runtime`, `windows`, and `windows-native` on `coverage_mode == 'full'` so the scoped lane skips them. `all-checks-passed` requires coverage and consumers on every expensive PR and the runtime/Windows jobs only on full PRs. Playwright provisioning is skipped in the scoped lane.

## Alternatives considered

**Run only the changed packages' tests and skip coverage entirely.** Rejected: a changed file that no selected test imports would escape the per-file gate; the incremental coverage gate keeps that check fail-closed.

**Make the scoped lane observational (non-blocking).** Rejected: the lane still validates real changed-surface behavior; only surfaces the change cannot affect are skipped.

**Extend the existing job graph with a new job instead of conditional steps.** Rejected: reusing the coverage/consumer jobs with mode-conditional steps keeps the required job set and the `all-checks-passed` aggregation intact.

## Consequences

Routine package-only changes now finish coverage and consumers in the time their focused tests take, instead of the full lane's wall clock, while every changed source file still faces the same 100% lines/statements/functions/branches gate. Dependency, lockfile, and infrastructure changes are unaffected and keep the complete lane (fail-closed). The workflow structure tests (`ci-workflow.spec.ts`) pin the new `coverage_mode == 'full'` conditions and the expanded push-reachable allowlist.

## Tests

`pnpm exec vitest run scripts/ci-pr-scope.spec.ts scripts/run-gates.spec.ts scripts/ci-workflow.spec.ts` passes. The scope spec covers the scoped classification, metadata/infra fallback to full, and the package-count bound; the run-gates spec covers the scoped coverage/consumer aggregates and their required inputs (`DSH_SCOPED_PACKAGES`, `DSH_INCREMENTAL_BASE`); the workflow spec pins the lane conditions and push-reachability.