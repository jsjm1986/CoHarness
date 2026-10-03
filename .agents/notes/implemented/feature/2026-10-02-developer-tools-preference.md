# Agent Note: Developer-tools preference gates diagnostics surfaces through the shared settings scope

Status: implemented

English | [中文](2026-10-02-developer-tools-preference.zh.md)

## Problem

Upstream `dsh-v0.2.0-rc.2` gives users a `developerTools` preference that withholds diagnostics surfaces — the trajectory view, the Agent preset seat, and the changed-files diff — plus sibling preferences the same settings row family owns. Upstream builds these on `ctx.configForms`, a preference service this fork never had: it duplicates schema rehydration, ordered writes, and memory-mode fallback that `SettingsScope`/`SettingsScopeBinder` already implement. The fork needed the user-facing capability without a second preference transport.

## Decision

The preference rides the existing scope transport. The `ui-settings` namespace is registered by the ui-settings Host half with `enabled` defaulting to true, and [`SettingsScopeBinder`](../../../../packages/client/ui-settings/src/client/settings-scope.ts) constructs one [`DeveloperToolsPreference`](../../../../packages/client/ui-settings/src/client/developer-tools.ts) at startup, exposed as `ctx.settingsScope.developerTools` — the binder's first non-`bind` member. Every consumer shares that instance's `enabled` observable and `setEnabled` writer, so a toggle repaints all gates from one accepted value: the trajectory entry drops out of `conversation.view` listing, the preset seat renders nothing and drops a stage a stale surface composed, and `DeliverablesInjected.showCodeDiff` withholds the changed-files card. The row itself registers into `settings.general.item` from ui-settings-general. Host-backed scopes stay disabled until an accepted value arrives; a refused write rejects the writer after the recovery read, matching how the row reports failure.

## Alternatives considered

- **Port `ctx.configForms` verbatim.** Rejected: it would duplicate the binder's revision fencing, ordered write queue, mirror decode, and account/host authority resolution behind a parallel API, and every future preference would have to pick between two equivalent services.
- **Bind a private scope per consumer.** Rejected: each scope's disposer belongs to the calling fiber, so rows and gates would hold identical namespace mirrors with independent invalidation; the shared member gives one subscription set and one accepted value.
- **Keep the always-on behavior.** Rejected: hiding diagnostics is the upstream-parity capability users asked for, and the gates also serve as the single switch for surfaces heavier than some deployments want.

## Consequences

`ctx.settingsScope` is no longer a pure `bind`/`describe` face; consumers get a shared member whose presence every stub in `dsh-client-test-runtime` now mirrors via `stubDeveloperTools`. Memory-mode scopes keep the preference local and enabled, so loopback-less contexts lose nothing. Upstream's `transcriptView`, `performanceUsage`, and `linkOpening` preferences have no counterpart yet and land on the same pattern when ported.
