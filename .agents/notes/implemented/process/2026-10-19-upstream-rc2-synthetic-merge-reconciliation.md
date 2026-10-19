# Agent Note: Upstream rc.2 synthetic-merge reconciliation closeout

Status: implemented

English | [中文](2026-10-19-upstream-rc2-synthetic-merge-reconciliation.zh.md)

## Problem

The `dsh-v0.2.1-rc.2` absorption landed as one synthetic three-way merge commit (`9221e43aee9`), and reconciliation surfaced a class of damage a file ledger alone does not prevent: single-sided overwrite. Where upstream's copy of a shared file won the merge, the fork's half of package manifests, `dsh` injection blocks, tsconfig generated-region markers, baseline fingerprints, and reference lists was dropped whole — every one of those files kept compiling only until a gate that reads the dropped half ran. A second class was stale decision residue: hand-maintained override rows in `gen-upstream-alignment-matrix.ts` still recorded `not-carried` verdicts for packages (`api/session-controller`, `boot/config-editor`) the merge had already carried, and the sovereignty manifest still claimed `upstreamOnly` for 33 packages physically on disk.

## Decision

Reconcile by owner, not by diff text. Each damaged artifact was resolved against its owning contract:

- Package manifests take the union of the HEAD~1 dependency sections and upstream's genuinely new entries, never one side verbatim; `verify-package-dependencies` then proves the policy table.
- `dsh`/`dsh.client` blocks restore to HEAD~1 unless the package's `src` actually absorbed upstream code needing the new declaration.
- `upstreamOnly` packages duplicating a local mechanism (`schedule/tool-schedule` vs `dsh-schedule` self-registration, `client/store` vs `client/runtime`, `client/ui-chat` vs `client/ui-conversation`) are removed rather than shadowed.
- Experimental-demoted packages split by owner decision: the seven the fork still ships in place keep their original directories and absorb upstream increments there; the five with no shipping-surface reference follow the demotion.
- Merge-deleted fork-owned files (119 sources, specs, and policy baselines, plus 1,542 archived note triplets) restore from HEAD~1; upstream-side deletions verified against the tag stay deleted.
- Generated catalogs, tsconfig paths, and the alignment matrix regenerate from source after every source-side fix rather than being hand-patched.
- The alignment matrix's carried rows must agree with the manifest and the disk; `verify-upgrade-records` rejects a carried package that still claims `not-carried`, so stale overrides are deleted instead of edited to look carried.

## Alternatives considered

**Patch each damaged file to whatever makes the nearest gate pass.** Rejected: it produces exactly the prose-shaped residue this note exists to prevent — a `not-carried` row edited in place instead of reconciled against the manifest, a dependency added where the policy demands peer+dev. Each fix names its owning contract or the next audit re-discovers the drift.

**Keep the upstream-only duplicates beside the local mechanism.** Rejected: two session-state sources and two schedule-tool registrations are correctness hazards regardless of which is mounted, and `verify-upstream-sovereignty` cannot classify a package that is simultaneously carried and rejected.

**Trust the merge's conflict markers as the damage boundary.** Rejected: the damaging merges were clean takes — no markers — so the audit boundary is "files whose HEAD~1 side vanished without an owner decision," enumerated mechanically rather than reviewed by taste.

## Consequences

The branch closes with every record gate green: `verify-upgrade-records` (22 files), `verify-upstream-sovereignty` (44 tracked / 252 adapted / 51 owned / 2 replaced / 41 upstream-only), `verify-package-dependencies`, `verify-cordis-config`, `verify-md-links`, full typecheck and lint, and the changed-surface test set. The [alignment-coverage note](2026-10-15-upstream-alignment-coverage-gaps.md) owns the audit-side lesson; this note owns the merge-side one — after any synthetic merge, the first verification pass is a damage census against HEAD~1 ownership, not a code review. The acceptance runbook keeps snapshot re-record and production health checks at release time.
