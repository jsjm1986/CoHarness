# Agent Note: Web e2e scaffold boots through a real managed profile

Status: implemented

English | [中文](2026-11-22-web-scaffold-managed-profile.zh.md)

## Problem

The web e2e scaffold mounted the shipped dsh-base and dsh-web-app bundle patch files as a static `patches` array through a hand-built `cordis:include` entry. When the bundle rows for `plugin-manager` and `hmr` gained the `disabled: !!js "!ctx.get('profileContext')"` gate, the scaffold's lack of a `profileContext` silently disabled both entries: the Plugins panel reported its no-managed-profile state, every `client-plugin-live` scenario timed out, and no profile patch file, bundle list, or HMR reconciliation existed for install/enable flows to observe. Master CI never exercised the lane because its `web verification` job is skipped, so the regression surfaced only on pull requests.

## Decision

`launchWebScaffold` now materializes a real profile before mounting the tree: `initProfile` writes the manifest, `dsh.profile.bundles` lists `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and a `dsh-web-scaffold-defaults` fixture bundle whose generated `cordis.patch.yml` carries the scenario's live-field defaults, and every `extraInstallAnchors` package is linked under the profile's `node_modules` with a `file:` dependency but kept out of `bundles` — installed the way `dsh plugin add` leaves it, not started. The scaffold provides `profileContext` (with `startedBundles` read back through `loadProfileDirectory` and `overlays` carrying the process-layer pins) and an immediately-fired `appReady`, then mounts via `mountRootInclude` with `readProfilePatches`, so HMR reconciliation and plugin-manager edits recompose from the same profile files a launcher reads. Module resolution stays in link mode through `healProfilesModuleFallback`; `pluginPackages` remains optional and unset.

## Alternatives considered

- **Provide `profileContext` without a real profile** — `plugin-manager` would start, but `listPlugins` reads the profile manifest and HMR reconciliation re-reads `readProfilePatches`; an empty directory fails both, so the panel would stay empty.
- **Keep the static patch array for the root include** — the first composition would boot, but a `writePluginEnabled` edit to the profile patch file would never reach a reload: only `readProfilePatches` re-derives the composition from disk.
- **Port `PluginPackages` and runtime resolution** — HMR reads `pluginPackages?.resolution` optionally and `refreshPackages` no-ops without it in link mode; the healed module fallback already resolves every bare name this harness uses, so the extra service buys nothing here.

## Consequences

The scaffold now reproduces the production managed-profile environment: plugin install/enable edits land in a real `cordis.patch.yml`, HMR watches the same files the launcher watches, and `ui-plugin-manager` reports managed instead of unavailable. Scenarios that never touch plugin management pay one extra profile write and two watched files. What was given up: the static single-file patch composition — a deliberate loss, because it could not express profile edits at all.
