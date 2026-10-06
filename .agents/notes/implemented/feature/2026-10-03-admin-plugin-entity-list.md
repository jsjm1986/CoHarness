# Agent Note: One plugin entity list replaces the split composition and install sections on the Admin Plugins page

Status: implemented

English | [中文](2026-10-03-admin-plugin-entity-list.zh.md)

## Problem

The Admin Plugins page used to organize itself around the implementation layers instead of the object an administrator actually thinks about. The composition matrix edited cordis entries and bundle selections; the manager page below it listed the same bundles again as cards beside the official plugins that registered configuration pages; and the same bundle could be enabled from either surface without any indication that the two controls wrote different layers. A beginner could not tell where a "plugin" lived, which switch did what, or that installing code, joining the composition, running, and configuring are four steps of one lifecycle.

## Decision

- [`composition.ts`](../../../../gateway/admin-ui/src/plugins/composition.ts) extracts the matrix's data layer into `usePluginComposition`: one hook owns the saved startup state, the observed file state, the live inventory, the merged row model, and the startup draft for the bound target, plus the `save`/`discard`/`applyLive`/`refresh` actions. Every control on the page edits this single draft, so a bundle toggled in a row and in the advanced matrix can never diverge.
- [`PluginManagerPage.tsx`](../../../../gateway/admin-ui/src/plugins/PluginManagerPage.tsx) renders one unified list: every installed or offered bundle and every official plugin item is one entity row carrying its kind tag (功能包/功能), a state badge (已启用/未启用/可启用 or live 运行中/已停用), a 将变更 badge when its startup position differs from the file's, the live 当前 switch, the 启动时 draft control (a bundle checkbox or an entry three-state select), and an inline detail that unfolds the former package, item, and row configuration pages in place. A search field and a status filter keep long lists navigable; package details no longer repeat the row's live switch.
- [`PluginMatrix.tsx`](../../../../gateway/admin-ui/src/plugins/PluginMatrix.tsx) becomes a pure view over the shared composition and folds behind a 高级：组成视图 summary for administrators and plugin developers who need the entry-level rows.
- [`PluginsPage.tsx`](../../../../gateway/admin-ui/src/pages/PluginsPage.tsx) leads the section with a lifecycle line (安装 → 启用 → 运行 → 配置), surfaces the draft as a sticky 保存/放弃 bar that counts pending differences across rows and matrix alike, and shows a stopped instance a placeholder plus the startup controls that still work offline. Deployments without the state store keep live-only controls, matching the matrix's existing degradation.

## Alternatives considered

**Keeping two sections with cross-links.** Renaming the sections and linking rows to cards would have explained the split without removing it; administrators would still edit two lists for one object, and the draft would have stayed matrix-private.

**Dropping the entry matrix entirely.** Cordis entries are the vocabulary the agent-side `plugin_manager` tool and `cordis.patch.yml` speak; removing the table would leave no surface for managed rows that own no friendly card. It folds instead of disappearing.

**A task-flow wizard.** An install→enable→configure flow suits first-time use but loses bulk management; the entity list keeps every facet reachable per row and can host a wizard later as an entry point, not a replacement.

## Consequences

Plugin identity converges on one row per entity across installation, enablement, startup state, and configuration, while the entry-level mechanics remain one disclosure away for advanced work. The shared composition object is now the single place drafts and live writes pass through, which is also the seam a future team-catalog or permission surface binds to. Coverage: `components.spec.tsx` pins the unified list, filters, pending badges, and startup controls; `PluginMatrix.spec.tsx` drives the hook through a page-shaped harness; `PluginsPage.spec.tsx` verifies the shared draft bar; `plugin-administration.e2e.ts` re-recorded its row golden against the built workflow.
