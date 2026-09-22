# Agent Note: Reuse verification work without weakening PR acceptance

Status: implemented

English | [中文](2026-09-22-pr-verification-throughput.zh.md)

## Problem

Local package edits often include a README and an Agent Note. Classifying all three as runtime inputs expands a bounded change into exhaustive CI. Browser scenarios also repeat unrelated conversation chrome in feature goldens, so ordinary interface wording changes require several unrelated refreshes. Independent provider, kernel, and package workflows can fail without changing the required PR summary.

## Decision

[Scope selection](../../../../scripts/ci-pr-scope.ts) retains all changed paths and excludes only recognized inert prose from runtime classification. Model inputs, configuration, shared runtime packages, and unknown inputs remain conservative. Scenario-only and golden-only browser changes select every registered owner plus the common smoke set; production component changes retain their business groups. Missing entries fail before execution. The [tiering decision](../testing/2026-09-11-web-verification-tiering.md) retains ownership of the group and smoke inventory.

The selector compares a frozen committed baseline with the candidate and defaults to their deduplicated union. Reports distinguish previous, candidate, and executed selections. An explicit candidate-policy experiment does not establish rollout approval: switching the default requires a reviewed commit with two representative execution batches, explained reductions, and no unexplained omissions or expansions. The frozen baseline exists only for this migration and is retired with that switch.

[Local preflight](../../../../scripts/pr-preflight.ts) reports dirty and committed scope, public checks, generated-file work, bilingual pairs, and missing references. Its default is read-only. `--check` runs registered mechanical checks, not the product inventory; `--fix-generated` invokes only registered deterministic generators. Neither command confirms translation semantics or refreshes expected output. Product checks remain explicitly unexecuted in the report, and evidence without complete input and environment identity is not reusable.

[Web fixture admission](../../../../scripts/verify-web-fixtures.ts) parses selected recorded Sessions before the dedicated browser lane builds. Runtime-created fixtures remain the owning scenario's responsibility. The local comprehensive graph makes typed lint wait for its generated declarations. Independent checks continue to report their own failures.

The [required result verifier](../../../../scripts/verify-pr-results.ts) consumes the same commit-bound plan as CI producers. Selected package, kernel, native Windows, and provider proofs join the summary through existing jobs and reusable workflows. Missing, failed, cancelled, and skipped required results fail acceptance. A required provider run retains the trusted-PR restriction and fails when its environment is unavailable; it cannot substitute replay or a key-presence test for a real call. Standalone manual and mainline workflows retain their roles.

The initial required real-provider acceptance scope is DeepSeek. Azure OpenAI and Anthropic are explicitly outside the supported acceptance scope; affected changes retain that unverified status in the report. Their manual upstream test entry remains available, and adding them to required acceptance needs an explicit scope-policy change and working credentials.

The mainline release pack owns the pnpm cache namespace consumed by PR jobs, and the mainline browser sweep owns Chromium's namespace. Installs still validate the lockfile. [Coverage timings](../../../../scripts/coverage-partitions.ts) are scheduling weights, never acceptance results: they are bound to toolchain, configuration, platform, resource profile, and age; corrupt or incompatible data uses cold weights. PR saves help later runs of the same PR; there is no additional mainline coverage job solely to seed weights. Partition inventory remains authoritative and each test runs exactly once.

[Artifact manifests](../../../../scripts/build-artifacts.ts) bind a clean candidate, environment, profile, input digest, and complete output inventory. Consumers reject missing, extra, stale, or corrupt outputs. Shared-build topology remains disabled without qualifying measurements. The [cost comparator](../../../../scripts/compare-ci-cost.ts) accepts at most three comparable pairs and retains a trial only when total installation, build, and transfer runner time falls at least 10%, median wall time does not rise, and the worst sample rises no more than 5%. Failed or incomparable samples cannot establish a gain. Independent consumer builds retain the [queue-delay rationale](2026-07-30-independent-ci-consumer-build.md).

Queue goldens cover their queue dock, the responsive layout golden covers the composer, and the CJK emphasis golden covers its Markdown content. Queue text, button names, disabled states, ordering, durable events, and responsive geometry remain exact. Complete assembly and lifecycle scenarios retain public chrome coverage. Refresh is explicit and followed by read-only replay; normalization does not broaden.

Web scaffolds allocate Session and document storage in a private root outside the model workspace. The explicit document root prevents ambient document access, shared admission-lock waits, and implicit legacy-upload migration. Storage initialization, filesystem locking, maintenance, and asynchronous disposal remain real; the scaffold removes its owned root only after disposal. The hermetic regression writes and reads real documents, protects a controlled ambient-home fixture, and runs in independent concurrent processes.

## Alternatives considered

**Relax blocking rules or borrow a green result from another commit.** Both shorten apparent waiting without proving the current candidate. Required checks and per-file coverage remain unchanged.

**Replace the executor or infer a complete runtime dependency graph.** Dynamic Cordis composition makes that a separate architecture project. Existing consumer relationships and scenario ownership supply the bounded selectors.

**Share every build immediately.** Producer queueing and artifact transfer can exceed duplicated compilation. A manifest proves identity, not a speed benefit; measured trials decide topology.

## Consequences

Faster feedback comes from scope accuracy, early diagnostics, smaller feature goldens, and reusable computation. The executor keeps its three statuses and dependency semantics. CI remains read-only. No additional runner tier, merge queue, or automatic approval layer is introduced.

Default-policy rollout, cross-job build sharing, broader snapshot contraction, and auto-merge require their respective acceptance evidence. A baseline failure remains a failure and cannot be renamed flaky to enable them. Performance reports separate saved work from newly required verification and retain first failures and rerun attempts.
