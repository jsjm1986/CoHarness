# Agent Note: First-run coverage debt is an explicit shrink-only baseline

Status: implemented

English | [中文](2026-09-02-first-run-coverage-baseline.zh.md)

## Problem

The required coverage lane enforces 100% statements, branches, functions, and lines for every measured package source file. Its first complete standard-hosted execution exposed existing debt across the document, collaboration, Gateway, LLM, session, SDK, browser, and subagent surfaces; the gate could not distinguish newly covered code from those pre-existing gaps while the repository moved to portable runners.

## Decision

`scripts/coverage-baseline.ts` records each currently uncovered source file as a literal path outside the per-file threshold while the rest of the repository keeps the 100% gate. The roster is shrink-only: `scripts/coverage-baseline.spec.ts` rejects globs, duplicate entries, paths outside package `src` trees, and stale paths, and every debt-removal change deletes its roster line together with the tests that restore coverage. The roster is included from the single root `vitest.config.ts` coverage exclusion list, so CI partitions and focused local coverage use the same inventory.

The baseline is a debt ledger, not a lower global threshold. Files outside the roster remain subject to every threshold, and a new source file cannot enter the baseline without a deliberate manifest change reviewed with its owning tests and documentation.

## Alternatives considered

**Lower the global threshold.** Rejected because a percentage would hide both existing and newly introduced gaps across unrelated files and would remove the per-file signal that identifies the next repair.

**Exclude entire packages or broad directory globs.** Rejected because document and collaboration packages contain covered files alongside debt; broad exclusions would erase useful evidence and make shrinkage unmeasurable.

**Leave the required lane red until every historical gap is repaired.** Rejected because the portable CI topology could not produce a mergeable signal for unrelated changes while the debt inventory was being paid down; the explicit list keeps the gate strict for all other files and makes repayment auditable.

## Consequences

The required coverage job can report current changes without treating historical debt as a repository-wide failure. The cost is maintaining a finite list and paying it down file by file; adding a source file to the list requires a recorded rationale and a corresponding shrink path.

## Testing

The roster unit tests pass with the affected package tests, and the coverage configuration consumes the exported list directly. The relevant focused test set covers settings registration/disposal, local jobs retention, LLM adapters and discovery, session persistence, subprocess behavior, and workflow session handling before the baseline is published.
