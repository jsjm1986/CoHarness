# Agent Note: Upstream alignment audits must cover feature graphs, scope boundaries, and diverged-seam contracts

Status: implemented

English | [中文](2026-10-15-upstream-alignment-coverage-gaps.zh.md)

## Problem

The alpha.2 alignment campaign audited by file and lane — the sovereignty manifest's `--residue` report (stale and unadopted files under `adapted`/`replaced` packages) plus per-lane Agent Notes — yet closeout verification still surfaced material omissions: the Plugins page's Creator entry (`plugins.add.actions` slot plus `CreatePluginMenuItem`), `experimental/worktree` and `experimental/tool-worktree` absent even from `upstreamOnly`, a dropped panel-reset contract on every new-session gesture, stale generated catalogs, and deferred export-JSDoc debt.

Upstream does ship written change records, so why did documented changes still slip? Because upstream's record is a **breaking-change upgrade guide**, not a feature inventory: `docs/upgrade-guide/` exists only to record externally perceptible breaking changes — `v0.2.1-alpha.1` lists 19 migration topics and `v0.2.1-alpha.2` has no guide directory at all. Additive features — a new slot, a menu entry, a new experimental package — produce no guide entry by design. Upstream feature evidence instead lives scattered across reference pages (`docs/subsystems/slots.md` does document `plugins.add.actions`), package READMEs, and Agent Notes. There is no feature-level changelog to consume; "read the release notes" is not an available audit input.

## Decision

Sync audits adopt three coverage units beyond the file ledger:

1. **Feature-graph ledger.** Each upstream user/model-facing feature is enumerated as its reachable surface — the slot or registration it hangs from, the contribution, the entry point, and the activation path — with a per-item verdict (ported / covered by a named local mechanism / rejected with reason) recorded in the sync's Agent Note. `plugins.add.actions` never appeared on any file ledger because the local Plugins page is an independent implementation: file diffs only expose gaps inside carried files.
2. **`upstreamOnly` completeness.** The sync closes by enumerating the upstream package tree against the manifest — every upstream package must be either carried or explicitly rejected with a reason. `experimental/inspector` and the webworker pair were recorded; `worktree`, `tool-worktree`, `session-search`, `session-titles`, `cot-translation`, `claude-code-mods`, `session-inspector`, `inspector-profile`, and `badge-skill` sat outside the manifest entirely — unreviewed, not rejected. The gate verifies listed entries; completeness of the enumeration itself is the auditor's checklist item.
3. **Diverged-seam contract check.** Where a `replaced`/`adapted` package's local mechanism differs from upstream's, the audit names the upstream *behavior contracts* that must survive translation, not just the file set. Upstream's `clearMain`/`replaceMain` folded "return to the Conversation surface" into session navigation; the fork's `activePanelId` panel model kept the selection clear but dropped the surface reset — breaking the Plugins-page Creator entry, the sidebar New Session button, and Workspace browser start actions until `selectPanel(null)` was composed at each gesture.
4. **Product-observable acceptance.** GUI-facing ports end with a reachable-entry check on a real build (menu opens, entry enabled, navigation lands), not only green tests — activation state, gating, and panel mechanics are invisible to package tests.
5. **Gates run per layer.** doc-sync, catalog regeneration, and export-JSDoc run against each landed layer rather than accumulating to a closeout sweep.

## Alternatives considered

**Keep the file ledger as the sole coverage unit.** Rejected by evidence: every class of miss above survived a complete file ledger with per-file verdicts — the ledger certifies file disposition, not feature reachability (the [client-lane audit](../architecture/2026-09-20-upstream-alpha2-client-lane-audit.md) records this caveat itself).

**Diff upstream reference docs and READMEs each sync.** Partially useful — it would have surfaced `plugins.add.actions` through `slots.md` — but it cannot expose code-only features, diverged-seam contract losses, or the `upstreamOnly` enumeration gap, and upstream docs themselves describe mechanisms, not a change list.

**Consume upstream Agent Notes as the feature inventory.** Rejected as the primary input: notes record rationale for a subset of changes and are not a per-release enumeration, though they remain the best source of contract semantics once a candidate feature is identified.

## Consequences

This closeout applied the corrected units: the Creator entry shipped with its slot contract and shared draft path (see [the Plugins-page Creator entry](../feature/2026-10-15-plugins-page-creator-entry.md)); the panel reset landed at all three gestures; `experimental/inspector`-style `upstreamOnly` reasons now have a completeness check as a standing audit step. Future upstream syncs start from the feature-graph ledger and the enumerated `upstreamOnly` table; packages that sit outside both remain unreviewed debt, not silent omissions. The [selective-sync policy](../architecture/2026-09-08-upstream-alpha2-selective-sync.md) keeps its behavioral-sync decision; this note supplies the coverage units that make it auditable.
