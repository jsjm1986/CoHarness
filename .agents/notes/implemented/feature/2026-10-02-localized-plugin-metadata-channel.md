# Agent Note: Localized plugin metadata travels the Host projection, not package-locale dictionaries

Status: implemented

English | [中文](2026-10-02-localized-plugin-metadata-channel.zh.md)

## Problem

Upstream dsh renders plugin-manager and plugin-inventory titles and descriptions through each client package's own `plugins.item` registration, whose `label` resolves against the client package's locale dictionaries at inject time. The admin gateway UI and the Web Settings plugin-list tab load no contributing client package, so neither surface could reach those dictionaries: official settings entries showed raw namespace ids (`dsh-agent-loop`), package cards showed technical names, and a package whose `meta` read failed had no in-place diagnostic. Upstream rc.1/rc.2 also rebuilt the install pipeline — registry selection with mirror recommendation, cancellation that survives a lost response, unknown/unconfirmed phases, hidden-install notices, and a GitHub-network recovery screen — which the admin manager page did not render at all.

## Decision

Registrants declare localized metadata on the Host-side contract and every remote surface resolves it through the active locale.

- `SettingsRegisterOptions.label` and `SettingsSectionHooks.label` in [`packages/settings/settings/src/index.ts`](../../../../packages/settings/settings/src/index.ts) accept a `LocalizedText` display title. The field rides the existing descriptor: `SettingsDescriptor.label` survives `describe({ redactSecrets: true })` because it is registrant metadata, not user data, and `SettingsNamespaceView.label` in [`packages/host/apiproxy/src/api/settings.ts`](../../../../packages/host/apiproxy/src/api/settings.ts) carries it across the wire with zod validation in `settings.schema.ts`. The admin ledger stores it as `labelText` beside the technical `label` fallback, and `PluginManagerPage` resolves it through `resolveText` against the active UI language, falling back to the namespace id when no label was declared. `agent-loop`, `bash-local`, `pwsh-local`, `subagent`, and `web-search-deepseek` declare the labels their upstream client dictionaries carry.
- `readPluginInventory` in [`packages/host/plugin-inventory/src/index.ts`](../../../../packages/host/plugin-inventory/src/index.ts) fills `PluginInfo.meta` for inventory entries and preset rows from the package manifest's localized `title`/`description`, as upstream does. Both consumers — the admin plugin manager and the Web Settings inventory tab — resolve `meta.title`/`meta.description` through `resolveText`, fall back to the full `pkg.name`/`row.moduleName` when no meta exists, and render a `metadataError` diagnostic beside the card when the meta read itself failed. The inventory tab also shortens literal name fallbacks for display only (npm scope and `cordis:`/`cordis-plugin-`/`dsh-`/`dsh-host-`/`dsh-client-` prefixes); the full specifier stays in details and search.
- The admin plugin manager adopts the upstream rc.2 install pipeline: `registries()`/`pluginRegistryProbe.fastest`/`waitForInstall` endpoints on the gateway, deferred cancellation (`sendCancellation` after the spec resolves), spec re-inspection after a cancelled install (`offerSpecAgain`), reconcile-on-load for interrupted installs, and the registry picker, GitHub-recovery, unconfirmed, and skeleton UI states — all in `gateway/admin-ui/src/plugins/`. The Host contract in [guided plugin installation](../architecture/2026-09-15-guided-plugin-installation.md) is unchanged: `cancelInstall` still answers only after cleanup, and the admin store's deferred send is a client-side ordering, not a second cancellation semantic.
- [`packages/client/locale/src/client/index.ts`](../../../../packages/client/locale/src/client/index.ts) gains `LocaleRuntime.resolveText`, and `useAnchoredPosition` gains upstream's `align` option; `PluginArtwork` in [`packages/client/ui-primitives/src/plugin-artwork.tsx`](../../../../packages/client/ui-primitives/src/plugin-artwork.tsx) renders manifest `icon` media with a generated fallback.

## Alternatives considered

**Load client packages' `plugins.item` contributions on admin surfaces.** The admin page runs outside the client plugin runtime, so it would need a second injection mechanism plus per-package locale loading; the Host already projects settings namespaces and the plugin inventory for every remote surface.

**Translate package names in the admin ledger.** A curated bilingual table (`BUILTIN_COPY`) existed for exactly two bundles. It could never cover user-installed packages, and upstream deleted the equivalent copy when `meta` became the single display channel; this change removes the table and lets uninstalled-namespace rows fall back to their id.

**Keep the flat name/description fields on `PackageView`.** Upstream dropped the untranslated manifest `description` from the card surface and kept `meta` as the only display channel, so a package with no localized `meta` shows its full name and no description rather than a mismatched-language blurb. This change follows: the card's `description` field is gone and `noDescription` copy is deleted.

## Consequences

Every settings namespace may now publish a display title; surfaces without one render the technical id unchanged. The `meta` channel is populated only for packages whose manifest declares localized metadata, so third-party packages keep name-only cards until they add `meta`. The two experimental bundles' admin cards now read "自动授权审查/智能体团队" (or English) without a ledger-side copy table. Deleting `BUILTIN_COPY`/`noDescription`/`builtin*` locale keys removes four dead keys; the zh and en locale files stayed in lockstep.

The cancelled-install flow changed observably: `closeInstall` during `starting` closes the dialog while the store delivers the cancellation once the spec resolves, and a cancelled install offers a re-inspection path instead of a silent reset. Both behaviors are pinned by the ported upstream specs (`manager-store.spec.ts`, `components.spec.tsx`) and the new `settings-store.spec.ts` label cases.
