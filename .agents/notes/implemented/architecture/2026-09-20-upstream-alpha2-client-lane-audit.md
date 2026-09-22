# Agent Note: Lane 7A client-package audit against upstream alpha.2

Status: implemented

English | [中文](2026-09-20-upstream-alpha2-client-lane-audit.zh.md)

## Problem

The `dsh-v0.1.5-alpha.1 → dsh-v0.1.6-alpha.2` residue report listed 20 stale files (local content still at alpha.1 while upstream changed it) and 78 unadopted files (added upstream, absent on disk) across `adapted`/`replaced` client packages. Each file needed a recorded verdict — port, already-covered, or intentional omission — so that the residue list carries no unexplained entries.

## Decision

**Ported** (behavior adopted where a live local consumer exists):

- `ui-tool` + `runtime` — Auto-review denial presentation (see the companion note `2026-09-20-auto-review-denial-presentation`).
- `host/directory-picker-native` — Win32 Alt-press foreground grant (see `2026-09-20-win32-directory-dialog-foreground`).
- `extensions/tool-cordis` — the runtime-inspection reductions in `inspect.ts`; `fiber-state.ts` is deleted. `present.ts`/`prompt.ts` stay at alpha.1 deliberately: upstream moved `cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine` registration into `cordis-host-runner`, while the local seam keeps every `cordis_*` model tool in `tool-cordis` and the runner service-only.
- `subagent/subagent` — the `SubagentCatalogEntry` client re-export (upstream now matches).
- `client/ui-settings-general` locales — the `connection.*` wording, minus the desktop-update keys the local web shell never renders; `connection.retry` stays because a local consumer still uses it.
- `client/ui-user-questions` — the module-comment rewrite; content now matches upstream.

**Recorded as intentionally absent** (`removedUpstreamPaths` entries; every listed path exists at the synced tag and is absent on disk):

- `client/modules` `entries.ts`/`entry-lifecycle.ts` — upstream reconciles page-owned Loader `Entry`s inside cordis; the local module system is built by the shell kernel before cordis exists (the bootstrap exception), so those helpers have no consumer.
- `client/web` `apply-injections.ts` — serves only upstream's desktop shell boot (`__dshDesktopBoot`), which the local web entry never runs.
- `client/ui-attachment` `drop-events.ts` — the local `ComposerAttachments` installs its document drop listeners inline.
- `client/ui-renderer` `errors.ts` — `SlotAssemblyError` lives in `session-provider.tsx` locally.
- `client/ui-conversation` (11 files) — upstream's `DraftEditor`/`editor/*` and `ConversationContent`/`MainPanel`/`Panel`/`WidthControls`/`DefaultConversationViews` skeleton; local input is the `blocks`/`machine`/`facade` architecture and the skeleton is the Workbench `ConversationRoot`/`Session`/`DetailsPanel` design.
- `client/ui-deliverables` (19 files) — upstream's changed-files Review tab and presented-file preview build on `ui-chat` contracts the fork does not carry; the local `ProducedFiles` turn-tail row covers the shipped subset. A diff-review surface remains a deferred product decision.
- `client/ui-message-feedback` (`FeedbackDialog`/`dialog.ts`/`surface.ts`) — upstream's session-level `/feedback` dialog; local deliberately ships the per-message popover note design instead.
- `client/ui-permission-presets` (`PermissionSelect`/`catalog.ts`) — the composer permission select lives in `ui-conversation`'s skeleton locally.
- `client/ui-plan` (9 files) — upstream's PlanCard/PlanPreview/review-store surface; local plan review is the `ui-user-questions` `PlanReviewPanel` composer takeover driven by the `plan-review` question intent.
- `client/ui-primitives` (6 files) — `darwin-desktop` is Electron-shell detection with no web consumer; `Checkbox` exists upstream only for the uncarried `ModelInputTypes`; `SiteGlyph`, `MarkdownDelegate`, and `file-link` serve only the uncarried `ui-chat`.
- `client/ui-settings-general` (4 files) — the desktop updater indicator and its update bridge/source are Electron-only.
- `client/ui-settings-models` (`ModelRow`/`ModelInputTypes`) — shared field rows for upstream's catalog editors; local editors keep their own inline fields.
- `client/ui-settings-plugins` (10 files) — `PluginConfigForm` and the Subagent field/controller family belong to upstream's `ui-plugin-manager` page, which the local keyed `settings.plugin.item` cards replace.
- `client/ui-sidebar` (`HeaderLeadingControls`) — macOS-desktop sidebar controls depending on `isDarwinDesktop`.
- `client/ui-subagent` (`sidebar-chat/`) — a right-sidebar conversation view over uncarried `ui-sidebar-right`/`client-resources`; local subagents render inside the conversation via `SubagentHeaderLineage`/`SubagentReadOnlyComposer`.
- `client/ui-trajectory` (`code-program.ts`, `string-wrapping-store.ts`) — the structured `run_code` inspector tab and persisted JSON-string-wrap preference serve upstream's trajectory views; the local trajectory shows sub-dispatch cells and the raw payload. A structured code inspector remains a deferred port needing local-view adaptation.
- `test-support/client-runtime` (`assembly/`) — boots upstream's `bootClient`/`Entry` loader path; the local pre-cordis bootstrap makes that path untestable as designed, and local tests compose plugins directly.

**Intentionally stale** (alpha.1 content retained; upstream's change has no local referent):

- `client/ui-settings-plugins` — `AgentLoopCard`, `BashCard`, `ConfigurablePluginsTab`, `fields.tsx`, `PluginsSettingsSection`, `slot-contract.ts`: the alpha.2 edits serve the plugin-manager forms; the local keyed-item cards are the shipping design.
- `client/ui-sidebar` `locales.ts` — upstream's `panels.label` feeds a global-panels `<nav>` the local `SidebarRoot` does not render.
- `client/web` `index.ts` — upstream's only change exports the uncarried `apply-injections.ts`.

## Alternatives considered

**Port upstream files wholesale per package.** Rejected: most unadopted files implement a desktop-shell or upstream-only contract with no local consumer, which violates the "require a current owner and need" rule; the ported set is exactly the subset with live local consumers.

**Carry upstream `ui-plugin-manager` beside the local settings cards.** Rejected: two plugin-settings surfaces would compete for the same section slot and diverge on every future sync.

## Consequences

The residue report's remaining entries are all explained: each is either a `removedUpstreamPaths` ledger line or a documented stale file. Deferred ports (deliverables diff review, trajectory code inspector, session-level feedback dialog) stay visible here rather than masquerading as completed work; adopting any of them requires the local consumer surface named above.

## Testing

`pnpm exec tsx scripts/sync-upstream-report.ts -- --tag dsh-v0.1.6-alpha.2 --residue dsh-v0.1.5-alpha.1` reproduces the audited lists; `pnpm exec tsx scripts/verify-upstream-sovereignty.ts` validates every `removedUpstreamPaths` entry exists at the synced tag and is absent on disk. Ported slices carry their own green suites (see the companion notes).
