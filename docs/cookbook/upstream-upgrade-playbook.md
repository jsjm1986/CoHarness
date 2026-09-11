# Upstream upgrade playbook

English | [中文](upstream-upgrade-playbook.zh.md)

This playbook defines the repeatable work for aligning CoHarness with an upstream DSH release while preserving cloud collaboration, Gateway authorization, Documents, Workbench, Android, native providers, and vendored Cordis ownership.

## Two change tracks

Product changes and upstream alignment use different records and review paths. Label the track in the PR before implementation starts.

- Product track: a new feature or bug fix owned by CoHarness. Implement it as a Cordis capability seam when it adds runtime behavior, with Service Definition, Provider, Consumer, disposal, invariant, focused tests, and an Agent Note. It does not change the upstream baseline or claim upstream parity.
- Upstream track: a comparison against one exact upstream tag or commit. Keep the upgrade plan, manifest, alignment matrix, compatibility decisions, migration notes, and validation evidence together. Separate product changes that are required to adapt the upstream behavior into a follow-up Product track PR when they can be reviewed independently.

If an upstream change is breaking, the Upstream track records the old and new public types, wire fields, Session format or persistence effects, and every consumer that must move. A compatibility adapter is temporary and has an owner and removal condition; it is not a reason to leave two permanent APIs.

## 1. Freeze the baseline

Record the CoHarness commit, upstream tag and commit, Node and package-manager versions, release family, and the exact worktree state before reading or changing code.

Create an upgrade worktree from the verified branch and keep the product worktree untouched. Save any uncommitted product changes as a patch or commit them on their own branch; never mix an upgrade comparison with an unknown working tree.

Run the change-scope report against the verified upstream or release base. Keep its JSON output with the upgrade record so a later merge-forward can distinguish the original scope from newly merged maintenance changes.

## 2. Build the alignment record

Use one row for each behavior or protocol area rather than one row per upstream commit or package. Each row records the upstream commits, the CoHarness owner, the local equivalent, wire impact, permission or data-egress impact, migration impact, focused tests, external evidence, and the chosen disposition.

Use these dispositions consistently:

- retain: the CoHarness owner remains authoritative and upstream code does not replace it.
- equivalent: the behavior already exists; add regression evidence without copying the implementation.
- adapt: adopt the upstream behavior inside the existing CoHarness API, persistence, Gateway, ACL, or UI owner.
- required: a real correctness, security, protocol, migration, or performance gap must be closed before release.
- defer: the change is a new product capability or needs a separate business decision.
- reject: the change violates the cloud, multi-runtime, permission, data-egress, or rollback boundary.

Do not use package-name similarity as evidence of equivalence. Trace the producer, consumer, lifecycle, persisted data, and model-visible result on both sides.

## 3. Audit Cordis seams first

Every adopted capability has a Service Definition, a Service Provider, and a Consumer. A Cordis package is complete only when all three roles and their ownership are clear.

Verify that Host and Client plugins use the repository's current inject, apply, effect, and event conventions. Registrations, listeners, timers, streams, caches, and HMR state must return disposers and stop on session, principal, runtime-generation, and plugin disposal.

Keep generated Remote declarations at the existing api/remotes merge point. Update host and client compiler faces, package exports, catalog generation, invariants, real Loader composition tests, and every SDK or external-plugin consumer together.

Compare the vendored Cordis manifest before changing vendor source. Apply the sync procedure and reapply local lifecycle hardening as exact edits; do not overwrite the vendor directory with an upstream tree.

## 4. Handle breaking changes in dependency order

For a breaking public type or wire change, update the Service Definition and its compatibility decision first. Then update Providers, Consumers, generated declarations, SDKs, ACP, Headless, snapshots, and documentation.

For Session changes, preserve adjacent migration edges and immutable-generation publication. A migration may publish a successor after source fingerprint revalidation, but it never overwrites, deletes, or silently downgrades a committed predecessor. Test torn tails, cancellation, concurrent writes, restart recovery, and provider-specific fallback.

For model-visible changes, update the SessionEventMap and replayable event before changing the prompt or UI. A value reaching a model request must be reconstructable from the durable log and projected consistently to both SDKs.

For Gateway or ACL changes, test the direct API, alternate RPC or Web paths, principal expiry, project visibility, read-only membership, revocation, and runtime-generation changes. A root package test is not evidence for the independent Gateway project.

## 5. Select evidence by impact

Use the smallest check set that covers the changed owner, then broaden it for shared seams. The versioned `scripts/ci-scope-policy.json` file owns shared-runtime, model-input, Gateway, and platform path classes; update that policy when a new capability owner is introduced instead of adding a one-off condition to the workflow.

- leaf package source: owning tests and changed-source coverage;
- Session, Cordis, Typert, Gateway, LLM, subagent, sandbox, subprocess, terminal, vendor, native, or client-connection: full runtime and generated-artifact checks;
- model prompts, skills, presets, or Agent instructions: replay or snapshot plus the owning composition test;
- Client, Workbench, or browser behavior: consumer build and browser snapshot;
- Gateway code: Gateway typecheck, build, unit tests, and PostgreSQL ACL tests when the environment is available;
- native or process confinement: the matching real-kernel or platform runner;
- package, lockfile, build, or release changes: full dependency, build, packed-install, and release verification.

Use the manual full-audit workflow for a release candidate or an uncertain impact set. Do not lower coverage thresholds or suppress a failing lane to make a scoped classification pass.

## 6. Merge and release in layers

Keep independent maintenance, dependency, workflow, and feature changes in separate PRs. For a stack, verify exact base and head SHAs and merge parent to child; after a merge-forward, rerun scope and the checks invalidated by the new base.

Require one stable aggregate status for ordinary PR merges. Keep platform inventories, nightly sweeps, real-API checks, and release packing separate unless their result is a required condition for the change. A skipped lane is acceptable only when the classifier records why its input domain cannot be reached.

Before publishing, verify the release family, package versions, packed install, public entrypoints, generated catalogs, native companions, and rollback artifact. Publication consumes immutable packed bytes and is manual; a dry run never changes a registry tag.

## 7. Close the record

Update the plan, manifest, alignment matrix, Agent Note, package README or subsystem page, snapshots, and bilingual pairing records in the same change. Replace pending evidence only with a successful job or external acceptance record; a failed run is evidence of failure, not of completion.

The final record names what remains deferred or externally unverified. A release is closed only when the required local and CI checks pass, every required external environment has evidence, the deployment rollback path is exercised, and the current version and commit are recorded.

Each upgrade has one durable record set: a plan for intent and choices, a manifest for exact commits and implementation state, and an alignment matrix for area-level evidence. Keep the record set under the repository's upgrade directory and link it from the PR. A later upgrade starts from the last released commit and references the preceding record instead of rewriting it.

## 8. Avoid these shortcuts

- Do not copy an upstream package tree over a CoHarness owner.
- Do not classify a shared runtime seam as a leaf package because only one file changed.
- Do not treat a skipped test, a cached artifact, or a green static check as Gateway, native, or real-model evidence.
- Do not update a snapshot when the underlying protocol or error contract is supposed to remain compatible.
- Do not merge a red required job because a different platform passed.
- Do not claim external acceptance from a local simulation.
