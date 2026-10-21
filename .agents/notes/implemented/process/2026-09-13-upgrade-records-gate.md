# Agent Note: Upgrade-records gate and commit inventory

Status: implemented

English | [中文](2026-09-13-upgrade-records-gate.zh.md)

## Problem

Upgrade work under `upgrades/` is recorded in alignment matrices, manifests, and plans, but nothing checked that those records were complete. A matrix row whose upstream commit coverage was silently empty read exactly like a row whose review found nothing to do — the alpha.1→rc.2 increment is hundreds of commits, and an unaccounted increment cannot be audited after the fact.

## Decision

`pnpm run verify-upgrade-records` gates every `upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-*.json` and `upgrades/manifests/UPGRADE-MANIFEST-*.json`, registered as the `upgrade-records` leaf in `run-gates.ts`. Records declaring `schemaVersion: 2` or newer must carry review metadata (`reviewDate`, baseline/target tags and commits) and every row must claim coverage through one of three forms: enumerated `upstreamCommits`, a `commitScope` of upstream path prefixes, or an explicit `noUpstreamCommitReason`. A `released` review state additionally requires an `evidence` field. Earlier schema generations keep their frozen shape and are validated only as parseable objects; every manifest still requires its plan pair under `upgrades/plans/`.

`scripts/gen-upstream-commit-inventory.ts` writes `upgrades/alignment/UPSTREAM-COMMIT-INVENTORY-<tag>.json`: every non-merge commit between the synced baseline and a target tag, bucketed by the sovereignty manifest — `carried` (touches a tracked/adapted/replaced package), `newUpstream` (touches a package absent from the manifest entirely), `upstreamOnly`, `owned`, or `none`. The gate cross-checks the inventory against the same-tag matrix: every `carried` or `newUpstream` commit must be claimed by a row's `upstreamCommits` or fall under a row's `commitScope`, assigning each relevant commit to a declared review area.

The active tag requires an inventory with the matrix's baseline and target commits. The generator and gate require complete ancestry for both endpoints; unrelated shallow refs do not block them. A truncated baseline can admit older commits into the difference as well as omit newer commits. The gate compares unique commit ids, counts, subjects, package paths and ownership buckets with Git and the current manifest. NUL-delimited paths preserve Unicode filenames, and root commits include their initial files. Historical inventories remain frozen; membership corrections retain the original file digest and explicit missing and extra commit ids.

The active matrix also agrees with `scripts/upstream-sync.json` on each carried package’s sovereignty and cannot label carried code `not-carried` or `upstreamOnly`. This verifies present source ownership, not functional completion: local tests, browser acceptance and external-provider evidence retain separate states. Frozen historical matrices are not reclassified against today’s tree.

## Alternatives considered

- Requiring enumerated commits on every row: rejected because area-wide rows cover dozens of commits; `commitScope` claims the path domain once and the inventory check verifies the coverage is real.
- Validating historical records under the v2 schema: rejected — records are frozen evidence of their generation; the gate strictness applies from v2 onward.

## Consequences

- A new upgrade target cannot ship records that silently skip upstream areas: either every commit touching carried packages is claimed, or the gate fails naming the unclaimed commits.
- `pending-*` review states remain legal but explicit, keeping honest in-progress status distinct from reviewed-and-complete.
- Regenerate the inventory after reclassifying sovereignty or after choosing a new target tag; a stale inventory fails the same-tag matrix pairing.

## Verification

- `verify-upgrade-records.spec.ts` covers row fields, coverage forms, released evidence, frozen historical records, exact active inventories, and generator/verifier refusal of shallow ancestry. It also checks baseline-only cutoffs, unrelated shallow refs, Unicode package paths and root commits.
- Gate run on the checked-in records reports every row carries commit coverage or an explicit reason.

The [candidate-bound evidence decision](2026-09-21-candidate-bound-gate-evidence.md) extends consumer selection and publication acceptance while retaining this note’s coverage and versioning rules.
