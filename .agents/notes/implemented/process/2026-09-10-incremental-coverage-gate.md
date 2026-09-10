# Agent Note: Incremental coverage gate

Status: implemented

English | [中文](2026-09-10-incremental-coverage-gate.zh.md)

## Problem

The repository's complete coverage lane is intentionally strict, but it runs the same large instrumented test graph for a small source change as it does for a repository-wide change. A faster path is needed for pull requests without allowing an unimported or under-covered changed source file to pass silently.

## Decision

Add `scripts/incremental-coverage.ts` and its tests as the first building block for an incremental pull-request gate. The utility derives changed package source files, normalizes absolute and relative Istanbul coverage-map keys, rejects a changed source file that is absent from the map, and requires 100% lines, statements, functions, and branches for every selected file. The package script is `test:coverage:incremental`.

This change does not replace or weaken the complete coverage lane. CI wiring uses the utility in the `ci-coverage-scoped` aggregate ([incremental CI lane gating](2026-09-10-incremental-ci-lane-gating.md)): it runs the changed packages' tests, then passes the merge-base ref and the produced coverage map here for the authoritative changed-file verdict. The existing full lane remains authoritative for repository-wide changes and baseline maintenance.

## Alternatives considered

**Use only Vitest's selected test set and rely on its thresholds.** Rejected: a changed file that no selected test imports can be absent from the coverage map and evade a per-file threshold.

**Lower the global threshold for pull requests.** Rejected: that would permit regressions in changed source and would hide coverage debt rather than isolate execution cost.

**Delete the full coverage lane.** Rejected: the full lane remains the repository-wide regression signal and is required when scope is broad or the changed-file map cannot be trusted.

## Consequences

Small source changes have a deterministic helper for changed-file coverage validation, while the complete coverage contract remains unchanged. The future CI integration must pass the merge-base path set and the final coverage map explicitly and must fail when either is unavailable.

## Tests

`pnpm exec vitest run scripts/incremental-coverage.spec.ts` passes with six tests covering source selection, path normalization, absent map entries, uncovered metrics, and empty input.
