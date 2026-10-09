# Agent Note: Plugins settings keeps configuration only

Status: implemented

English | [中文](2026-10-09-settings-plugins-configuration-only.zh.md)

## Problem

Two surfaces listed the same install base. The sidebar Plugins page owned install, removal, and enablement while the Settings Plugins section repeated a read-only inventory (`ui-settings-plugin-inventory`) beside the configuration cards — and that second tab also carried this page's module-sync diagnostics, a lifecycle signal presented as configuration. A user could inspect a stale install in Settings yet only repair it in the sidebar, and the duplicated listings risked drifting grant and status behavior.

## Decision

Delete `ui-settings-plugin-inventory`. The Settings `plugins` section keeps only the `configurable` contribution ([Plugin settings tabs](../architecture/2026-08-11-plugin-settings-tabs.md)); when the `settings.plugins.tab` ledger holds one entry the section renders that body without the tab strip. The section gains a manage link shown only while `ctx.pluginNavigation` is provided, calling `openBundle()` — whose argument is now optional — so the link opens the panel's list view. The manager provides `pluginNavigation` at activation rather than inside the `main` entry's mount, so a caller can select the panel before it first renders.

The page-owned module-sync diagnostics move to the sidebar Plugins page, which owns lifecycle. The manager face binds a `clientSync` hook to `ctx.modules.entries.state` and a `retryClient` action to `entries.retry()`; retry still re-runs only this page's module graph and never mutates Host enablement. The Host `pluginInventory` Remote stays — it feeds the manager's package list and the admin transport — so no capability was removed, only a duplicated presentation.

## Alternatives considered

**Keep the inventory tab inside Settings.** Rejected: two listings of the same install base duplicate grant, status, and diagnostics surfaces; the section is the configuration surface, not a second manager.

**Fold the preset-grouped inventory into the sidebar page.** The panel already shows installed state, row phases, and per-bundle detail; reproducing the inventory's second layout over the same rows would carry no new information.

**Keep the module-sync banner in Settings.** The banner reports this page's Loader state — a lifecycle concern that belongs beside the other lifecycle controls — and Settings no longer reads the module system at all.

## Consequences

The web-app bundle drops one client package, its slot contribution, and its test fixtures; baselines and goldens move with it. Settings Plugins renders cards plus a manage link when `ui-plugin-manager` is composed and cards alone when it is not — the link hides rather than dead-ends. Live-client e2e tracks the terminal card's staged timeout edit as page-owned state and finds sync failures under `[data-client-sync-failure]` on the panel.
