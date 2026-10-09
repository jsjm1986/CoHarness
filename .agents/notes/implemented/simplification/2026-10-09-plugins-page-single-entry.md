# Agent Note: The Plugins page is the single plugin entry

Status: implemented

English | [中文](2026-10-09-plugins-page-single-entry.zh.md)

## Problem

Plugins appeared under two same-named doors. The sidebar Plugins page owned install, removal, and enablement, while the Settings dialog's Plugins section held the five host-plane configuration cards — and until this change it also carried a read-only inventory tab (`ui-settings-plugin-inventory`) that repeated the install base and hosted this page's module-sync diagnostics. A user had to learn which door installed and which configured, and the settings section duplicated aggregation machinery the manager page already had: its `plugins.item` slot, `ItemCard`/`ItemDetail` pair, and namespace filter were designed for exactly these official cards but had no registrants.

## Decision

The sidebar Plugins page is the only user-facing plugin surface. `ui-settings-plugin-inventory` is deleted and the whole Settings `plugins` section goes with it: the `settings.plugins.tab` and `settings.plugin.item` slots, the section and tab chrome, and the `PluginsSettingsSection`/`ConfigurablePluginsTab` components.

`ui-settings-plugins` registers each of its five cards as one `plugins.item` entry keyed on its settings namespace (`shell`, `agent-loop`, `subagent`, `subagent-model-selection`, `web-search-deepseek`). The cards lost their collapse shell (`PluginCard`) and now render through `PluginForm`, a body-only frame with the same read-only band and save footer; the manager page renders `view: 'summary'` on the card and `view: 'page'` on the item's own page. The Configuration group already filters items to ids the Host's `settings.describe` serves, so an uncomposed plugin leaves no shell.

`ctx.pluginNavigation` gains `openItem(itemId)`, which selects the panel and lands on `{ kind: 'item', id }`, for a plugin that deep-links to its own page — the experimental voice input registers `speech-to-text` this way and falls back to `requestSettingsSection()` when no manager is composed.

The page-owned module-sync diagnostics moved to the sidebar Plugins page, which owns lifecycle. The manager face binds a `clientSync` hook to `ctx.modules.entries.state` and a `retryClient` action to `entries.retry()`; retry still re-runs only this page's module graph and never mutates Host enablement. The Host `pluginInventory` Remote stays — it feeds the manager's package list and the admin transport — so no capability was removed, only duplicated presentation.

## Alternatives considered

**Keep a configuration-only Plugins section in Settings.** Rejected: two same-named doors still ask the user to learn the split, and the section duplicated slot chrome, mounting, and filtering the manager page already provides.

**Fold the preset-grouped inventory into the sidebar page.** The panel already shows installed state, row phases, and per-bundle detail; reproducing the inventory's second layout over the same rows would carry no new information.

**Keep the module-sync banner in Settings.** The banner reports this page's Loader state — a lifecycle concern that belongs beside the other lifecycle controls — and Settings no longer reads the module system at all.

## Consequences

The web-app bundle drops one client package, its slot contributions, and its test fixtures; baselines and goldens move with it. Settings offers no Plugins navigation row. The feature-owned tab mechanism this supersedes is recorded in [the archived tab note](../../archived/architecture/2026-08-11-plugin-settings-tabs.md). Live-client e2e tracks the terminal item's staged timeout edit as page-owned state and finds sync failures under `[data-client-sync-failure]` on the panel.
