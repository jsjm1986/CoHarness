# Agent Note: Candidate-bound gate evidence and fork consumers

Status: implemented

English | [中文](2026-09-21-candidate-bound-gate-evidence.zh.md)

## Problem

A successful aggregate can omit a fork consumer, accept an unexplained skip, or refer to a different commit or artifact. Upgrade records can describe unfinished source review while publication checks only package versions. Replacing the upstream executor would increase recurring merge conflicts without repairing those omissions.

## Decision

The existing executor retains its three outcomes and dependency ordering. Hygiene uses its existing mode, and shared static execution owns vendored resolution, rescoping, coverage-exclusion validity, test honesty and consumer-reference checks. Full, partitioned and incremental coverage share one measurement policy; explicit type-only syntax is derived from source and runtime files with missing data still fail.

[Consumer relations](../../../../scripts/ci-consumer-relations.json) connect the loop and Session to both SDKs, model governance to Gateway and Admin UI, and notification protocols to Android. Source references and workflow jobs must exist. Selection remains in shadow operation: the public classifier records previous, candidate and executed decisions, and CI executes their union. Retiring that union requires two representative CI batches with no unexplained reductions, additions or new execution faults, recorded in a reviewed commit. Timing cannot trigger a switch.

[Execution evidence](../../../../scripts/gate-evidence.ts) separates stable identities and raw results from observations. [Publication readiness](../../../../scripts/release/readiness.ts) derives minimum checks from candidate changes, resolves exactly one upgrade record, rejects pending acceptance and unclaimed paths, and verifies report bytes against authenticated GitHub artifacts. Publish consumes the tested bytes. Missing native, API, sandbox or device evidence prevents publication; a local success cannot substitute for those environments.

The active non-package matrix records changed upstream gate inputs, replay instructions, regression sources and retirement conditions. The upgrade-record check invalidates replay acceptance when the pinned upstream target or source identity changes. An upstream replacement retires the local adaptation only after its consumer regressions pass.

## Alternatives considered

**A new registry, scheduler and six-outcome executor.** Rejected because those changes conflict with upstream's pinned gate inventories and outcome assertions. A derived report supplies release evidence without replacing execution semantics.

**Imports alone determine scope.** Rejected because Cordis overlays, workers, published entries and shared UI sources reach consumers outside the static import graph. Explicit relations and conservative composition rules remain auditable.

**A report supplied by the release caller proves readiness.** Rejected because it can omit required checks or claim a different successful run. Repository policy determines minimum proof, and GitHub supplies the authoritative report bytes, job result and commit.

## Consequences

Source review and product remediation remain independent of this implementation. Pending upgrade decisions, missing test environments and existing red tests remain red. The selector can be rolled back to the union without reverting product work; a faulty publication guard pauses publication until repaired or replaced by explicitly approved equivalent verification.

Android compilation, native bridge instrumentation and real push delivery are separate proofs. Strict Python typing remains deferred with reassessment on public SDK type changes or the next upstream SDK update. No global script coverage threshold or permanent generated bilingual gate catalog is introduced.

The [incremental coverage](2026-09-10-incremental-coverage-gate.md), [lane classification](2026-09-10-ci-lane-scope-classification.md), [upgrade records](2026-09-13-upgrade-records-gate.md) and [independent npm sequences](2026-08-10-npm-release-sequences.md) notes remain active: their distinct coverage, source-review and versioning decisions still apply. [The release reference](../../../../scripts/release/README.md) owns operator inputs and proof requirements.
