# Agent Note: Path-gated pull-request CI lanes

Status: implemented

English | [中文](2026-09-06-path-gated-pr-ci.zh.md)

## Problem

Every pull request started the complete coverage, browser snapshot, release-shaped runtime, Wine, and native Windows lanes even when the change only updated a pinned GitHub Action or documentation. The stable `all checks passed` verdict also treated an intentionally omitted lane as a failure, so reducing work required changing the aggregate contract at the same time.

## Decision

The CI workflow adds a small `pr-scope` classifier, [`scripts/ci-pr-scope.ts`](../../../../scripts/ci-pr-scope.ts). A diff touching only documentation omits unrelated runtime and platform consumers; every unknown input defaults to the full lane inventory, and installer pin bumps receive the runtime and platform proof lanes their workflow owners select ([controlled dependency upgrades](2026-10-08-controlled-dependency-upgrades.md)).

[`scripts/ci-pr-scope.ts`](../../../../scripts/ci-pr-scope.ts) emits the commit-bound validation plan. The `all checks passed` job uses [`scripts/verify-pr-results.ts`](../../../../scripts/verify-pr-results.ts) to require success from every selected job and permit intentional omissions.

The scope command computes changed paths against the base SHA from GitHub's pull-request event after a full checkout. Default `shadow` execution takes the union of frozen and candidate lane selections; an explicit `candidate` policy selects the candidate plan. Local tests exercise documentation-only, installer, and source/dependency classifications without GitHub Actions.

## Alternatives considered

**Run the complete gate set for every pull request.** This preserves maximum uniformity, but spends the longest runners on changes that cannot affect product behavior. The classifier keeps the full set for source, dependency, lockfile, and workflow-logic changes.

**Use only changed-file filters in workflow triggers.** That would prevent entire workflows from starting, but would make required checks disappear and would not give one stable aggregate verdict. The scope job keeps the workflow and aggregate check present for every pull request.

**Trust a pull-request-provided base or scope value.** Rejected because a branch can modify its own classifier inputs. The selector computes the diff from the event's trusted base SHA after a full checkout and fails closed for unrecognized changes.

**Skip all checks for documentation or action-pin changes.** Rejected because static, compatibility, and keyless SDK checks are cheap guardrails for workflow and packaging regressions. Those checks remain mandatory on the light path.

## Consequences

Documentation pull requests no longer allocate the long-running coverage, browser, packaging, Wine, and native Windows runners. Unrecognized, product, dependency, lockfile, installer, and workflow-logic changes keep the release-sized validation the selected plan names. The workflow still exposes one stable aggregate check, and the aggregate log records whether the expensive lanes were selected and why.

## Testing

The scope classifier unit tests cover documentation-only, installer, and source/dependency changes, and the CI workflow contract test covers the scope job, conditional expensive jobs, and aggregate dependency contract. Local coverage exercises classification and the result-admission contract only; hosted lane execution on the real runner matrix remains the CI proof that selected jobs actually pass.
