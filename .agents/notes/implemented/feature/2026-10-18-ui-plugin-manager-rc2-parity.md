# Agent Note: rc.2 parity for the plugin manager showcase

Status: implemented

English | [中文](2026-10-18-ui-plugin-manager-rc2-parity.zh.md)

## Problem

Upstream `dsh-v0.2.1-rc.2` reorganized the Plugins page around curated optional-bundle sections the fork lacked: **Experimental plugins** on the main list, a **More** page holding the held-back bundles, on-demand Official cards that install the catalog target the Host offers, **Update** on version or source drift, missing-files and update-available tags, localized feature previews on detail pages, a split **Add plugin** menu accepting contributed actions, and a contributed `plugins.tab` page tab. Porting the file set wholesale would have replaced the fork's architecture, because upstream's page is built on `configForms`, lacks management authorization, and reports product analytics.

## Decision

Each increment lands as a fork-shaped port over the fork's model:

- `PluginManagerPage` adopts upstream's group model — Built-in plugin settings (`plugins.item` entries filtered to served settings namespaces), Experimental plugins, and Installed plugins — plus `EXTENSION_BUNDLES`/`MORE_BUNDLES` ordering: always-held bundles rank the main list, held-back bundles join it only while enabled, and the More page lists every offered official bundle with the Codex and Claude Code subagents last. The fork-only `schedule-bundle` joins `MORE_BUNDLES` because it ships `locale/en.json`, `locale/zh.json`, and `icon.svg`; packages without that metadata are never listed.
- `manager-store` keeps the fork's `settingsScope`-backed `configForm`, `manage`/`denied` access gate, `clientSync` status and retry, and `scopePolicy` caption. `packageView()` forwards upstream catalog fields (`official`, `availability`, `installTarget`) when a newer Host publishes them and otherwise derives `official` from `optional` and `availability` from optional/installed/missing facts, so the on-demand install, exact `saveExact` target, and remove-then-install **Update** lanes activate end-to-end wherever the Host reports a target. `saveExact` rides the install options through a structural extension because the fork's generated install schema does not declare it.
- `slot-contract` redeclares `BundleAvailability` locally and keeps `ConfigPageForm` on `SettingsScopeSnapshot`/`SettingsMutationScope`; `plugins.tab`, `plugins.add.actions`, and `PluginTabInstall` match upstream.
- Detail pages render `BUNDLE_PREVIEWS` SVGs keyed by package name — one 640×300 asset per shipped language for the badge-skill and voice-input bundles under `src/client/assets/` — with a localized `previewUnavailable` fallback on decode failure; packages have no preview declaration interface.
- All `productAnalytics` imports and tracking calls were dropped rather than stubbed; `sanitize-install-input.ts` is ported with its spec even though its only upstream consumer was the analytics attempt log.
- Fork-only surfaces stay: `openItem` in `pluginNavigation`, the administrator-grant denied view, the module-sync failure panel, fork icon names, and the `clientBundle(name, …)` tsdown form.

## Alternatives considered

- Adopting upstream's `configForms` surface was rejected: the fork's settings architecture binds editable namespaces through `settingsScope`, and moving the page would strand the `ConfigPageForm` contract every `plugins.item` registrant uses.
- Half-landing the official catalog by faking `official`/`installTarget` server-side was rejected: inventing a Host contract the wire does not carry would ship an untestable lane, so the client consumes the fields only when the Host supplies them and the limitation is recorded in the package README.
- Keeping `productAnalytics` behind an optional `ctx.get` was rejected: the fork excludes the package entirely, and dead instrumentation would accrete.

## Consequences

The page is organizationally identical to rc.2 for Hosts that publish the catalog fields, and degraded but complete — curated ordering, previews, menu, tabs, missing-files and update tags — on the current fork wire. `subagent-codex` and `subagent-claude-code` gained upstream's `locale/` metadata and `icon.svg` so every named bundle resolves a showcase card.

## Verification

`npx vitest run packages/client/ui-plugin-manager` — 6 files, 254 tests, including ported catalog install/update, More-list pinning, preview language/fallback, add-menu keyboard, and `sanitize-install-input` specs; `npx tsc --noEmit -p packages/client/ui-plugin-manager/tsconfig.client.json` clean. Increment evidence in `.rc2-work/logs/pm-showcase-port.log`.
