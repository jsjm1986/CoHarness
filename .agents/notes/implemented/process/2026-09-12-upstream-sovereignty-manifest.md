# Agent Note: Upstream sovereignty manifest and sync gate

Status: implemented

English | [中文](2026-09-12-upstream-sovereignty-manifest.zh.md)

## Problem

This fork shares no git history with upstream `deepseek-harness`: every upstream integration so far has been a selective, per-capability port rather than a merge. Which `packages/<group>/<pkg>` directories track upstream byte-for-byte, which carry owned deltas, which are fork-only, and which upstream ships but the fork does not carry was recorded only in prose upgrade plans and one-off alignment matrices. Those records drift silently, cannot answer "what would adopting tag X touch?" without redoing the analysis, and give CI nothing enforceable.

## Decision

Per-package sovereignty now lives in `scripts/upstream-sync.json`, a versioned manifest keyed by `<group>/<pkg>`. Each carried package is `tracked` (its `src/` is identical to the synced upstream commit), `adapted` (it exists upstream but its `src/` carries owned deltas), `replaced` (it exists upstream but the fork owns the contract wholesale, so upstream diffs can never land by file merge and must be ported behavior by behavior), or `owned` (it has no upstream counterpart); directories upstream ships that the fork does not carry sit in `upstreamOnly`. `replaced` entries must name a `note` file recording the substitution; `adapted` and `replaced` entries may name `removedUpstreamPaths`, repo-relative files present at the synced commit and deliberately absent on disk, which the gate verifies in both directions. `upstreamOnly` entries are `{ package, reason, replacedBy? }` objects so "not carried" cannot be confused with "not yet reviewed". The recorded baseline is `dsh-v0.1.6-alpha.2`.

`pnpm run verify-upstream-sovereignty` gates the manifest inside `ciStaticGates` as the `upstream-sovereignty` gate: it compares current `src/` files, including uncommitted imports, with the synced commit through a temporary Git index; Git applies checkout normalization and excludes ignored generated output without changing the real index. It re-checks every `tracked` claim and enforces the manifest↔disk↔tag bijections, including that no `owned` package exists at the synced tag and no `upstreamOnly` entry exists on disk. `pnpm run upstream-sync:report -- --tag <next>` prints the Markdown increment toward a newer tag bucketed by sovereignty — `tracked` entries are the file-level conflicts to reconcile — so adopting the next baseline starts from a computed inventory instead of a hand-built matrix. `--residue <olderTag>` additionally lists files under `adapted`/`replaced` packages still identical to an older upstream tag even though upstream changed them before the synced commit (`stale`), separated from files upstream added that were never carried (`unadopted`) — the mechanical detector for below-baseline residue the sovereignty class alone cannot show. The `windows-native` and `serial-windows` checkouts fetch complete history (`fetch-depth: 0`) because a depth-1 clone carries no tags for the gate to resolve.

## Alternatives considered

**Keep the per-upgrade alignment matrices.** Rejected because each matrix freezes one comparison at authoring time; the manifest is one living record the gate re-verifies against the working tree and the mirrored tag on every run.

**Record sovereignty as package.json fields or README prose.** Rejected because the classification must be checked in one sweep against git state; a central manifest keeps the bijection checks (manifest against disk against tag) a single-pass computation.

**Baseline at the newest landed tag (`dsh-v0.1.5-alpha.1`).** Rejected because landed is not validated: the gate's `tracked` set is only meaningful against a commit whose local `src/` state was actually reconciled, which is the alpha.2 sync recorded in [the alpha.2 sync note](../architecture/2026-09-08-upstream-alpha2-selective-sync.md).

## Testing

`pnpm exec vitest run scripts/verify-upstream-sovereignty.spec.ts scripts/sync-upstream-report.spec.ts scripts/run-gates.spec.ts scripts/ci-workflow.spec.ts` covers manifest validation, the disk/tag bijections, the `tracked` zero-diff re-check, `replaced`-without-note rejection, `removedUpstreamPaths` escape and resurrection rejection, `upstreamOnly` reason and `replacedBy` validation, the report's bucketing and `--from`/`--tag`/`--residue` parsing, the gate's membership in the `ci-static` and `ci-windows-observational` aggregates, and the Windows checkouts' `fetch-depth: 0`. Temporary repository cases reject unstaged, staged, deleted, new, executable-mode and symlink changes, accept matching untracked imports and normalized CRLF checkouts, and preserve the real index byte-for-byte.

## Consequences

Sovereignty is a mechanical fact instead of prose: a package claiming `tracked` while its `src/` drifts fails the gate, and adopting an upstream-listed package without classifying it fails the bijection. A package restoring a removed upstream file must delete its `removedUpstreamPaths` row in the same PR. Clones without the mirrored tags cannot run the git-dependent checks; the spec skips them there while the gate itself fails loud. Re-baselining means updating `syncedTag`/`syncedCommit`/`upstreamOnly` and flipping whatever sovereignty the recompute shows, driven by the `upstream-sync:report` increment; the `--residue` output is the work list for sweeping files that froze below the declared baseline.
