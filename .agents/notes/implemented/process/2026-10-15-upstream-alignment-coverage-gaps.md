# Agent Note: Upstream alignment audits must cover feature graphs, scope boundaries, and diverged-seam contracts

Status: implemented

English | [中文](2026-10-15-upstream-alignment-coverage-gaps.zh.md)

## Problem

The alpha.2 alignment campaign audited by file and lane — the sovereignty manifest's `--residue` report (stale and unadopted files under `adapted`/`replaced` packages) plus per-lane Agent Notes — yet closeout verification still surfaced material omissions: the Plugins page's Creator entry (`plugins.add.actions` slot plus `CreatePluginMenuItem`), `experimental/worktree` and `experimental/tool-worktree` absent even from `upstreamOnly`, a dropped panel-reset contract on every new-session gesture, stale generated catalogs, and deferred export-JSDoc debt.

Upstream does ship written change records, so why did documented changes still slip? Because the audit never consumed the channel that carries them. Upstream publishes a complete bilingual per-release feature changelog on **GitHub Releases** — `dsh-v0.2.1-alpha.1` names the Plugins-page Creator entry verbatim ("插件管理页新增「让 Agent 创建插件」入口") and `dsh-v0.2.1-alpha.2` names Git Worktrees, cot-translation, `working_directory`, and the Claude Code/Codex install entries. The in-repo `docs/upgrade-guide/` is a different artifact — breaking changes only, 19 entries for alpha.1 and no directory at all for alpha.2 — and it was the only written record consulted. Release notes were never an audit input: the campaign reconciled file diffs (`--residue`) and in-repo guides against the code, but no step mapped the release-notes feature list to shipped surfaces. Every omitted item on this page was already written down in a source we did not read.

## Decision

Sync audits adopt these coverage units beyond the file ledger:

1. **Release-notes reconciliation first.** The GitHub Releases changelog is the canonical per-release feature inventory. Every bullet — features, fixes, experience changes, and other-changes entries — gets a verdict (ported / covered by a named local mechanism / rejected with reason / not applicable to this product) recorded in the sync's Agent Note, and notes for *every* release between the old and new baselines are reconciled, not only the target tag's. The Creator entry shipped in `dsh-v0.2.1-alpha.1` notes and persisted into the alpha.2 tree, so an alpha.1→alpha.2 delta audit never re-surfaced it.
2. **Feature-graph ledger.** Each reconciled item is traced to its reachable surface — the slot or registration it hangs from, the contribution, the entry point, and the activation path. `plugins.add.actions` never appeared on any file ledger because the local Plugins page is an independent implementation: file diffs only expose gaps inside carried files.
3. **`upstreamOnly` completeness.** The sync closes by enumerating the upstream package tree against the manifest — every upstream package must be either carried or explicitly rejected with a reason. `experimental/inspector` and the webworker pair were recorded; `worktree`, `tool-worktree`, `session-search`, `session-titles`, `cot-translation`, `claude-code-mods`, `session-inspector`, `inspector-profile`, and `badge-skill` sat outside the manifest entirely — unreviewed, not rejected. The gate verifies listed entries; completeness of the enumeration itself is the auditor's checklist item.
4. **Diverged-seam contract check.** Where a `replaced`/`adapted` package's local mechanism differs from upstream's, the audit names the upstream *behavior contracts* that must survive translation, not just the file set. Upstream's `clearMain`/`replaceMain` folded "return to the Conversation surface" into session navigation; the fork's `activePanelId` panel model kept the selection clear but dropped the surface reset — breaking the Plugins-page Creator entry, the sidebar New Session button, and Workspace browser start actions until `selectPanel(null)` was composed at each gesture.
5. **Product-observable acceptance.** GUI-facing ports end with a reachable-entry check on a real build (menu opens, entry enabled, navigation lands), not only green tests — activation state, gating, and panel mechanics are invisible to package tests.
6. **Gates run per layer.** doc-sync, catalog regeneration, and export-JSDoc run against each landed layer rather than accumulating to a closeout sweep.

## Alternatives considered

**Keep the file ledger as the sole coverage unit.** Rejected by evidence: every class of miss above survived a complete file ledger with per-file verdicts — the ledger certifies file disposition, not feature reachability (the [client-lane audit](../architecture/2026-09-20-upstream-alpha2-client-lane-audit.md) records this caveat itself).

**Diff upstream reference docs and READMEs each sync.** Partially useful — it would have surfaced `plugins.add.actions` through `slots.md` — but it cannot expose code-only features, diverged-seam contract losses, or the `upstreamOnly` enumeration gap, and upstream docs themselves describe mechanisms, not a change list.

**Reconcile only the target tag's release notes.** Rejected: a feature announced in an earlier release persists into later trees without reappearing in any delta — the Creator entry was announced at alpha.1 and was live code at alpha.2. Reconciliation must cover every release since the last synced baseline.

**Consume upstream Agent Notes as the feature inventory.** Rejected as the primary input: notes record rationale for a subset of changes and are not a per-release enumeration, though they remain the best source of contract semantics once a candidate feature is identified.

## Consequences

This closeout applied the corrected units: the Creator entry shipped with its slot contract and shared draft path (see [the Plugins-page Creator entry](../feature/2026-10-15-plugins-page-creator-entry.md)); the panel reset landed at all three gestures; `experimental/inspector`-style `upstreamOnly` reasons now have a completeness check as a standing audit step. Future upstream syncs start by reconciling every release's changelog since the last baseline, then trace each item through the feature-graph ledger and the enumerated `upstreamOnly` table; packages and features outside all three remain unreviewed debt, not silent omissions. The [selective-sync policy](../architecture/2026-09-08-upstream-alpha2-selective-sync.md) keeps its behavioral-sync decision; this note supplies the coverage units that make it auditable.
