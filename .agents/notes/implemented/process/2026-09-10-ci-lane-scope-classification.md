# Agent Note: CI lane scope classification

Status: implemented

English | [中文](2026-09-10-ci-lane-scope-classification.zh.md)

## Problem

Pull requests currently receive a single `run_expensive` scope result even though the repository runs several different kinds of checks. This makes documentation and action-only changes look like full product validation, and it makes CI failures difficult to classify from the aggregate status. The existing selector also needs to remain fail-closed for source and dependency changes.

## Decision

The pull-request scope classifier now reports the changed source and package paths, whether the change is documentation-only, and the selected coverage and snapshot modes in addition to the existing `run_expensive` and `reason` outputs. The workflow exposes these values on the scope job and prints them in the successful aggregate verdict.

The new fields are explanatory metadata only in this change. The existing blocking job graph and the `run_expensive` decision remain unchanged: source and dependency changes still run the complete expensive lane set, while action-only and documentation-only changes continue to use the existing skip behavior. Environment-sensitive lanes are not made non-blocking by this classifier.

## Alternatives considered

**Replace `run_expensive` immediately with independent job conditions.** Rejected: changing the job graph and the classifier in one step would make it difficult to distinguish a reporting change from a validation-policy change.

**Treat all dependency changes as non-blocking.** Rejected: dependency and lockfile changes can alter package resolution, build output, and runtime behavior, so they retain the full lane set.

**Infer failure category from the final aggregate job only.** Rejected: the aggregate result cannot explain whether the scope was documentation-only, source-bearing, or dependency-bearing.

## Consequences

CI now records enough scope metadata for later incremental coverage and snapshot selection work without changing current merge protection. Existing workflow structure tests continue to protect the blocking job set and fork/Dependabot fail-closed conditions.

## Tests

`pnpm exec vitest run scripts/ci-pr-scope.spec.ts scripts/ci-workflow.spec.ts scripts/run-gates.spec.ts` passes. The tests cover action-only, documentation-only, and source/dependency scope classifications plus the existing gate graph.
