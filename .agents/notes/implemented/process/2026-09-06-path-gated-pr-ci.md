# Agent Note: Path-gated pull-request CI lanes

Status: implemented

English | [中文](2026-09-06-path-gated-pr-ci.zh.md)

## Problem

Every pull request started the complete coverage, browser snapshot, release-shaped runtime, Wine, and native Windows lanes even when the change only updated a pinned GitHub Action or documentation. The stable `all checks passed` verdict also treated an intentionally omitted lane as a failure, so reducing work required changing the aggregate contract at the same time.

## Decision

The CI workflow adds a small `pr-scope` classifier. It marks a pull request as light when the diff contains only documentation or only `pnpm/action-setup` pin replacements inside workflow files. Light pull requests retain static analysis, Node compatibility, and the keyless Python SDK check; coverage, build-backed consumers, release-shaped Python runtime, and both Windows lanes are omitted. All source, dependency, lockfile, and workflow-logic changes retain the complete pull-request lane set.

`all checks passed` now requires the always-run static, compatibility, Python SDK, and scope jobs. It requires the expensive jobs only when `pr-scope` selects the full lane set. A skipped expensive job is therefore an intentional result with an explicit scope reason, while a skipped always-run job still fails the verdict.

The classifier runs from the trusted pull-request base SHA after a full checkout. It is a small TypeScript module with unit coverage so workflow edits can test the action-only, documentation-only, and full-change classifications without needing GitHub Actions.

## Alternatives considered

**Run the complete gate set for every pull request.** This preserves maximum uniformity, but spends the longest runners on changes that cannot affect product behavior. The classifier keeps the full set for source, dependency, lockfile, and workflow-logic changes.

**Use only changed-file filters in workflow triggers.** That would prevent entire workflows from starting, but would make required checks disappear and would not give one stable aggregate verdict. The scope job keeps the workflow and aggregate check present for every pull request.

**Trust a pull-request-provided base or scope value.** Rejected because a branch can modify its own classifier inputs. The selector computes the diff from the event's trusted base SHA after a full checkout and fails closed for unrecognized changes.

**Skip all checks for documentation or action-pin changes.** Rejected because static, compatibility, and keyless SDK checks are cheap guardrails for workflow and packaging regressions. Those checks remain mandatory on the light path.

## Consequences

Action-pin and documentation pull requests no longer allocate the long-running coverage, browser, packaging, Wine, and native Windows runners. Product, dependency, lockfile, and workflow-logic changes keep the existing release-sized validation. The workflow still exposes one stable aggregate check, and the aggregate log records whether the expensive lanes were selected and why.

## Testing

The scope classifier unit tests cover action-only, documentation-only, and source/dependency changes. The CI workflow contract test covers the scope job, conditional expensive jobs, and aggregate dependency contract. A subsequent pull request must exercise both a light diff and a full diff through GitHub Actions before the optimization is treated as complete.
