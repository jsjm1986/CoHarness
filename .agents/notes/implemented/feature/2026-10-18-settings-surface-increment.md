# Agent Note: Upstream settings-surface increment for rc.2

Status: implemented

English | [中文](2026-10-18-settings-surface-increment.zh.md)

## Problem

Upstream rc.2 split its Plugins settings into a tab chrome plus feature-owned tabs (`settings.plugins.tab` slot) and ships `ui-settings-plugin-inventory`, a read-only Cordis Loader inventory tab. The fork's `ui-settings-plugins` owned only per-plugin configuration cards; the inventory tab had been adjudicated `reject` as duplicative of the sidebar Plugins panel. The owner's plugin-parity directive reverses that call: every upstream settings feature lands, mounted inside the fork's own settings architecture.

## Decision

The upstream `PluginsSettingsSection` chrome and the `settings.plugins.tab` contribution slot are ported into the fork's `ui-settings-plugins`, alongside the existing form cards (AgentLoop, Bash, SubagentLimits, SubagentModelSelection, WebSearch) which keep their role. `ui-settings-plugin-inventory` is ported verbatim (package, bilingual locales, tests) and registers one lazy `'all'` tab reading `remote.pluginInventory.list` plus `modules.entries.state` for client-sync retries. The `web-app` bundle patch composes it beside `dsh-host-plugin-inventory`, which already served the wire.

Fork keeps its settings model: per-plugin config cards remain the editing surface; the inventory tab is read-only and does not duplicate install or enablement actions. `desktop.update.*` (Desktop lane) and `deepSeekAccount` sections stay excluded.

## Alternatives considered

- **Keeping the reject** was rejected by the owner's directive; the tab is informational rather than duplicative management.
- **Merging inventory into `ui-plugin-manager`** was rejected: upstream's own placement is the settings tab, and the fork's manager already owns action surfaces.

## Testing

`npx vitest run packages/client/ui-settings-plugins packages/client/ui-settings-plugin-inventory` — 9 files, 145 tests pass. Not carried: upstream's `client/modules` release gate + `HostReleasePrompt` chain — it needs Host-published release identity the fork's manifest does not yet serve; tracked as a pending increment on the `ui-settings-general` matrix row.

## Consequences

The settings Plugins page now carries the upstream tab chrome, so upstream plugin tabs can mount into the fork without rework. The inventory tab is strictly read-only — enablement stays in the fork's manager surfaces, avoiding a second mutation path over the same Loader state.
