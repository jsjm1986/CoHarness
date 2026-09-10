# Agent Note: PR, dependency, and stack merge policy

Status: implemented

English | [中文](2026-09-10-pr-and-dependency-merge-policy.zh.md)

## Problem

CI lanes and Dependabot PRs drifted from the repository's merge norms. Major-version upgrades were blocked on the version number alone even when the project code adapted cleanly, while toolchain bumps leaked into feature PRs. Stacks were merged by guessing parent/child dependencies instead of verifying exact heads. The result was red-lane churn and unclassifiable "all checks passed: fail" verdicts.

## Decision

PRs, dependency upgrades, and stacks follow one explicit policy:

- **PR checklist.** Every PR carries the pre-merge checklist in `.github/pull_request_template.md`: exact base/head SHAs, focused tests plus changed-source coverage, keyless snapshot/replay for model-visible behavior, baseline vs environment failure classification, explicit record-only snapshot secrets, parent→child merge-forward for stacks, and release manifest/readiness/rollback/public-entry verification for deployment PRs.
- **Dependabot policy.** A version bump is judged by real project compatibility, not its magnitude. Patch/minor bumps merge when the blocking checks pass and only known baseline or environment lanes remain. Major bumps always land as an independent migration PR with its own typecheck, build, package, snapshot, and runtime verification; they are never rejected solely because they are major. Toolchain upgrades (`@types/node`, Vite, and peers) are kept out of feature PRs and get a dedicated migration PR.
- **Stack / merge-forward.** A stack merges parent→child: update the parent first, then rebase/merge the exact heads down the chain. Only the official `gh stack` capability or a plain single-PR merge is used; dependency relationships are never guessed by hand. `--force-with-lease` replaces raw `--force`, and an in-progress merge-forward preserves its checkpoint before taking a newer base.
- **Failure classification.** Every failing lane is attributed to code, generated artifact, model fixture, or platform environment before any merge; a red baseline is not masked as "all checks passed."

## Alternatives considered

**Reject any major-version PR without review.** Rejected: upstream ships breaking updates, and the fork must track them; a version number alone predicts nothing about project-code compatibility.

**Merge stacks by inspecting branch names.** Rejected: branch names are not a trustable dependency graph; exact head/base SHA verification is the only reliable source.

## Consequences

Dependabot and toolchain PRs are routed to a migration review instead of being closed on the version label. Stack merges stay reproducible by rerunning the same verified head/base sequence. The PR template gives reviewers a single place to check that the changed surface was actually exercised and that a remaining red lane is a classified baseline rather than a hidden code failure.

## Tests

No behavior code changes; the policy is enforced by the existing CI lane classification (`scripts/ci-pr-scope.ts`), incremental coverage (`scripts/incremental-coverage.ts`), and snapshot record preflight (`scripts/snapshot-preflight.ts`) gates already covered by their specs and CI workflow tests.
