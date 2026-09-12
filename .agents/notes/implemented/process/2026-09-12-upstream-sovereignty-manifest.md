# Agent Note: Upstream sovereignty manifest and sync gate

Status: implemented

English | [中文](2026-09-12-upstream-sovereignty-manifest.zh.md)

## Problem

This fork shares no git history with upstream `deepseek-harness`: every upstream integration so far has been a selective, per-capability port rather than a merge. Which `packages/<group>/<pkg>` directories track upstream byte-for-byte, which carry owned deltas, which are fork-only, and which upstream ships but the fork does not carry was recorded only in prose upgrade plans and one-off alignment matrices. Those records drift silently, cannot answer "what would adopting tag X touch?" without redoing the analysis, and give CI nothing enforceable.

## Decision

Per-package sovereignty now lives in `scripts/upstream-sync.json`, a versioned manifest keyed by `<group>/<pkg>`. Each carried package is `tracked` (its `src/` is identical to the synced upstream commit), `adapted` (it exists upstream but its `src/` carries owned deltas), or `owned` (it has no upstream counterpart); directories upstream ships that the fork does not carry sit in `upstreamOnly`. The recorded baseline is `dsh-v0.1.3-alpha.2` (commit `82a5fd61a7cf5c293cec4bdff68f455398d685e9`): the alpha.5/0.1.5 content is landed per [the alpha.4/alpha.5 sync note](../architecture/2026-09-03-selective-upstream-alpha4-alpha5-sync.md) but is not a validated sync baseline.

`pnpm run verify-upstream-sovereignty` gates the manifest inside `ciStaticGates` as the `upstream-sovereignty` gate: it re-checks every `tracked` claim with `git diff --quiet <syncedCommit> HEAD -- packages/<key>/src` and enforces the manifest↔disk↔tag bijections, including that no `owned` package exists at the synced tag and no `upstreamOnly` entry exists on disk. `pnpm run upstream-sync:report -- --tag <next>` prints the Markdown increment toward a newer tag bucketed by sovereignty — `tracked` entries are the file-level conflicts to reconcile — so adopting the next baseline starts from a computed inventory instead of a hand-built matrix. The `windows-native` and `serial-windows` checkouts fetch complete history (`fetch-depth: 0`) because a depth-1 clone carries no tags for the gate to resolve.

## Alternatives considered

**Keep the per-upgrade alignment matrices.** Rejected because each matrix freezes one comparison at authoring time; the manifest is one living record the gate re-verifies against the working tree and the mirrored tag on every run.

**Record sovereignty as package.json fields or README prose.** Rejected because the classification must be checked in one sweep against git state; a central manifest keeps the bijection checks (manifest against disk against tag) a single-pass computation.

**Baseline at the newest landed tag (`dsh-v0.1.5-alpha.1`).** Rejected because landed is not validated: the gate's `tracked` set is only meaningful against a commit whose local `src/` state was actually reconciled, which is the alpha.2 sync recorded in [the alpha.2 sync note](../architecture/2026-09-08-upstream-alpha2-selective-sync.md).

## Testing

`pnpm exec vitest run scripts/verify-upstream-sovereignty.spec.ts scripts/sync-upstream-report.spec.ts scripts/run-gates.spec.ts scripts/ci-workflow.spec.ts` covers manifest validation, the disk/tag bijections, the `tracked` zero-diff re-check, the report's bucketing and `--from`/`--tag` parsing, the gate's membership in the `ci-static` and `ci-windows-observational` aggregates, and the Windows checkouts' `fetch-depth: 0`. `pnpm run verify-upstream-sovereignty` reports 4 tracked, 226 adapted, 25 owned, and 28 upstream-only against `dsh-v0.1.3-alpha.2`; the adapted count includes the shared `util/package-manifest` package and its local invariant companion.

## Consequences

Sovereignty is a mechanical fact instead of prose: a package claiming `tracked` while its `src/` drifts fails the gate, and adopting an upstream-listed package without classifying it fails the bijection. Clones without the mirrored tags cannot run the git-dependent checks; the spec skips them there while the gate itself fails loud. Re-baselining means updating `syncedTag`/`syncedCommit`/`upstreamOnly` and flipping whatever sovereignty the recompute shows, driven by the `upstream-sync:report` increment.
