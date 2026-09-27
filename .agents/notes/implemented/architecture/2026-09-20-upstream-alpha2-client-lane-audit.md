# Agent Note: Lane 7A client-package audit against upstream alpha.2

Status: implemented

English | [中文](2026-09-20-upstream-alpha2-client-lane-audit.zh.md)

## Problem

The `dsh-v0.1.5-alpha.1 → dsh-v0.1.6-alpha.2` residue report listed 20 stale files (local content still at alpha.1 while upstream changed it) and 78 unadopted files (added upstream, absent on disk) across `adapted`/`replaced` client packages. Each file needed a recorded verdict — port, already-covered, or intentional omission — so that the residue list carries no unexplained entries.

## Decision

**Ported** (behavior adopted where a live local consumer exists):

- `client/ui-message-feedback` — Session feedback dialog and command action behavior are adopted; the existing message-feedback sidecar remains independent. The [feedback decision](../feature/2026-07-28-feedback-command.md) owns that distinction.
- `client/modules`, `client/hmr`, and `client/web` — startup batches and page-owned Loader entries follow the [shared entry-lifecycle decision](2026-09-23-page-owned-client-entries.md). Pre-Cordis bootstrap and subsequent Loader ownership are compatible; the earlier omission rationale does not apply.
- `ui-tool` + `runtime` — Auto-review denial presentation (see the companion note `2026-09-20-auto-review-denial-presentation`).
- `ui-tool` terminal card — the settled-side spill-notice and persistent-shell guards plus the browser-safe `@deepseek-ai/dsh-spill-policy/notice` recognition entry they consume. Decision detail lives in the [Web terminal card](../feature/2026-07-28-web-terminal-card.md) note.
- `ui-tool` + `fs/tool-fs` `read_image` gallery — `image-card-model.ts`, the shared `read-family-row.tsx` assembly, the keyed `read-image-row.tsx`, and the persisted `presentationMeta` path projection are adopted; `readCallLine` carries the call's 1-based offset into `openFile`. Upstream's `tool.call.images` child slot is not ported: the local chat node already hands the row a `renderMessageImages` owner prop backed by `conversation.message.images`, and the details panel reaches the same attachment gallery through its own `conversation.details.images` sibling seat — slot names are global, so a second parent cannot redeclare the chat slot name.
- `host/directory-picker-native` — Win32 Alt-press foreground grant (see `2026-09-20-win32-directory-dialog-foreground`).
- `extensions/tool-cordis` — the runtime-inspection reductions in `inspect.ts`; `fiber-state.ts` is deleted. The model execution registrations follow upstream retirement, while local read-only `cordis_inspect_self` and explicit references remain. The [retirement decision](../simplification/2026-09-22-retire-dynamic-cordis-model-tools.md) supersedes the earlier retention choice.
- `subagent/subagent` — the `SubagentCatalogEntry` client re-export (upstream now matches).
- `client/ui-settings-general` locales — the `connection.*` wording, minus the desktop-update keys the local web shell never renders; `connection.retry` stays because a local consumer still uses it.
- `client/ui-user-questions` — the module-comment rewrite; content now matches upstream.

**Non-carried paths and local consumers.** `removedUpstreamPaths` records file disposition, not completion of the corresponding behavior. Approved behavior still requires a reachable local consumer and acceptance evidence:

- `client/ui-attachment` (3 files) — `drop-events.ts` is inlined into the local `ComposerAttachments` listeners; `FileCard*` stays unported because the local composer renders pending documents through `InputBar`'s `DocumentRail` rows.
- `client/ui-renderer` (3 files) — `SlotAssemblyError` lives in `session-provider.tsx` locally; `bindings.tsx`/`registry.ts` are upstream's render-machinery split the local renderer does not share.
- `client/ui-conversation` (38 files) — upstream's `DraftEditor`/`editor/*`, `ConversationContent`/`MainPanel`/`Panel`/`WidthControls`/`DefaultConversationViews` skeleton, `contract/*` and `conversation/*` assembly machinery, `context-occupancy`/`view-selection`, and `historical-images`; local input is the `blocks`/`machine`/`facade` architecture, the skeleton is the Workbench `ConversationRoot`/`Session`/`DetailsPanel` design, and historical images load through `MessageImages` + `loadImage`.
- `client/ui-deliverables` — turn-tail deliverables and immutable changed-file Review use the [authorized workspace review](2026-09-23-authorized-workspace-review.md) and shared sidebar. Missing upstream filenames do not imply a deferred product decision.
- `client/ui-permission-presets` (`PermissionSelect`/`catalog.ts`) — the composer permission select lives in `ui-conversation`'s skeleton locally.
- `client/ui-plan` (9 files) — upstream's PlanCard/PlanPreview/review-store surface; local plan review is the `ui-user-questions` `PlanReviewPanel` composer takeover driven by the `plan-review` question intent.
- `client/ui-primitives` (7 files) — `darwin-desktop` has no Electron consumer; `Checkbox` and `SiteGlyph` remain unported. `MarkdownDelegate` and `file-link` are adopted through the [account-scoped sidebar](2026-09-23-account-scoped-auxiliary-sidebar.md). `rank-by-name.ts` — upstream's shared fuzzy `/`-menu ranking (ordered-subsequence scoring with prefix-first ordering, consumed by `ui-commands` and `ui-skill`) differs from the local `ui-commands` `filterOptions`, which filters rows by case-insensitive substring over label and detail and keeps source order; the local mechanism is a deliberate simplification and fuzzy ranking remains a deferred port needing adaptation to the `SelectOption` label/detail model. `FoldToggle.tsx`/`file-size.ts` serve only unported upstream surfaces (the FileCard rail and folded transcript view).
- `client/ui-settings-general` (4 files) — the desktop updater indicator and its update bridge/source are Electron-only.
- `client/ui-settings-models` (7 files) — `ModelRow`/`ModelInputTypes` are shared field rows for upstream's catalog editors and the `WelcomeNotice`/`welcome-store`/`operations`/`onboarding-copy` surface drives upstream's first-run catalog onboarding; local editors keep their own inline fields and have no first-run model onboarding.
- `client/ui-settings-plugins` — [Subagent limits](2026-09-23-scoped-subagent-limits.md) and upstream field help are adapted to the keyed `settings.plugin.item` cards. Model-selection controls use the same namespace-card owner and atomic Host writes; Admin configuration integration still requires a local consumer; the different settings shell does not waive them.
- `client/ui-sidebar` (`HeaderLeadingControls`) — macOS-desktop sidebar controls depending on `isDarwinDesktop`.
- `client/ui-subagent` (`sidebar-chat/`, `subagent-lineage.ts`) — a right-sidebar conversation view over uncarried `ui-sidebar-right`/`client-resources`; local subagents render inside the conversation via `SubagentHeaderLineage`/`SubagentReadOnlyComposer`, which owns its own lineage derivation.
- `client/ui-theme` (`FontSizeRow*`) — upstream's content font-size preference row; the local theme settings expose `AppearanceRow` only and carry no font-size setting.
- `client/ui-trajectory` (`code-program.ts`, `string-wrapping-store.ts`, `trajectory-event-projection.ts`) — the structured `run_code` inspector tab, the event projection feeding it, and the persisted JSON-string-wrap preference serve upstream's trajectory views; the local trajectory shows sub-dispatch cells and the raw payload. A structured code inspector remains a deferred port needing local-view adaptation.
- `client/ui-workspace` (4 files) — `rows/WorkspaceBrowser*`, `navigation.ts`, and `subagent-lineage.ts` are upstream's browser-row layout; the local `WorkspaceBrowser` lives directly under `src/client/` with its own navigation and lineage code.
- `client/ui-goal`, `client/ui-layout`, `client/ui-model-selection`, `client/ui-settings`, `host/directory-picker`, `sdk/client`, `session-query/session-log-export`, `context/session-reference`, `fs/tool-fs-search` — one file each: upstream surfaces the local architecture covers elsewhere (activation-source, DocumentTitle, model catalog, settings-contract, picker types, SDK launch helper, log-archive writer, session-reference spill, `ripgrep.d.ts` ambient typings) or does not carry by design.
- `test-support/client-runtime` (`assembly/`) — local package tests compose plugins directly, while assembled browser tests exercise the adopted page-owned Loader entries. The pre-Cordis bootstrap is not a reason to omit Loader lifecycle validation.

**Retained local composition:**

- `client/ui-settings-plugins` — `AgentLoopCard`, `BashCard`, `ConfigurablePluginsTab`, `PluginsSettingsSection`, `slot-contract.ts`: the local keyed-item cards own the settings section. Individual upstream interaction and configuration behaviors still require adoption or an explicit product decision.
- `client/ui-sidebar` `locales.ts` — upstream's `panels.label` feeds a global-panels `<nav>` the local `SidebarRoot` does not render.

## Alternatives considered

**Wholesale replacement of local packages.** Rejected because it would discard Workbench and Gateway ownership. Adopted behavior instead uses thin adapters to those owners; an absent consumer remains unfinished work.

**Carry upstream `ui-plugin-manager` beside the local settings cards.** Rejected: two plugin-settings surfaces would compete for the same section slot and diverge on every future sync.

## Consequences

The file ledger does not certify feature equivalence. Structured trajectory inspection and complete Admin configuration remain implementation obligations. Deliverables Review and Session feedback have local consumers and their own evidence; final-candidate acceptance remains separate.

## Testing

`pnpm exec tsx scripts/sync-upstream-report.ts -- --tag dsh-v0.1.6-alpha.2 --residue dsh-v0.1.5-alpha.1` reproduces the audited lists; `pnpm exec tsx scripts/verify-upstream-sovereignty.ts` validates every `removedUpstreamPaths` entry exists at the synced tag and is absent on disk. Ported slices carry their own green suites (see the companion notes).
