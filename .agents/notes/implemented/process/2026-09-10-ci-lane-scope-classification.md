# Agent Note: CI lane scope classification

Status: implemented

English | [中文](2026-09-10-ci-lane-scope-classification.zh.md)

## Problem

Pull requests currently receive a single `run_expensive` scope result even though the repository runs several different kinds of checks. This makes documentation and action-only changes look like full product validation, and it makes CI failures difficult to classify from the aggregate status. The existing selector also needs to remain fail-closed for source and dependency changes.

## Decision

The pull-request scope classifier now reports the changed source and package paths, whether the change is documentation-only, and the selected coverage and snapshot modes in addition to the existing `run_expensive` and `reason` outputs. The workflow exposes these values on the scope job and prints them in the successful aggregate verdict.

The selector keeps the fail-closed default while distinguishing independent domains. Session, Cordis, Typert, Gateway, LLM, subagent, sandbox, subprocess, terminal, vendored, native, and client-connection paths always use the full runtime inventory. Model-visible skills and preset inputs are runtime inputs rather than inert documentation. Gateway and Gateway admin UI changes select their independent npm checks through `gateway_mode` and `admin_ui_mode`.

The consumer aggregate sets its compatibility smoke to source-only because the aggregate owns the single build consumed by its compiled checks. The post-merge browser sweep uses the same bounded gate, snapshot, and typecheck settings as the pull-request consumer lane. Release workflows run only for release-relevant paths and cancel superseded pull-request packs; Sandbox keeps native paths, nightly, and manual runs.

## Alternatives considered

**Replace `run_expensive` immediately with independent job conditions.** Rejected: changing the job graph and the classifier in one step would make it difficult to distinguish a reporting change from a validation-policy change.

**Treat all dependency changes as non-blocking.** Rejected: dependency and lockfile changes can alter package resolution, build output, and runtime behavior, so they retain the full lane set.

**Infer failure category from the final aggregate job only.** Rejected: the aggregate result cannot explain whether the scope was documentation-only, source-bearing, or dependency-bearing.

## Consequences

CI now records enough scope metadata for independent lane selection while preserving a full inventory for shared runtime seams. The aggregate still fails for every selected required job, and skipped jobs are accepted only when the classifier explicitly selects their mode. Existing workflow structure tests protect the blocking job set and fork/Dependabot fail-closed conditions.

## Tests

`pnpm exec vitest run scripts/ci-pr-scope.spec.ts scripts/ci-workflow.spec.ts scripts/run-gates.spec.ts scripts/incremental-coverage.spec.ts` passes. The tests cover action-only, documentation-only, model-input, shared-runtime, Gateway, and source/dependency classifications plus the gate graph and strict coverage-map parsing.
