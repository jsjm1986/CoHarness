# Agent Note: Plugins-page feature cards bind their patch row

Status: implemented

English | [中文](2026-10-23-plugins-item-patch-row-binding.zh.md)

## Problem

`plugins.item` entries were keyed on the host-plane settings namespace they edited and registered only while the Host served that namespace. A feature switched off through the profile patch lost its card with no in-product way to switch it back on, and a card could not carry the row's live state because its key was a settings namespace, not the running-profile entry it configured. The shell feature had a second defect: its Host row changes with the platform (`bash-sandbox` versus `pwsh-sandbox`), so no single namespace key could name the live row.

## Decision

**A `plugins.item` entry's `id` names the cordis patch row its feature runs as.** The Plugins page resolves each id against the Host's running-profile entries: `patchId` answers directly, and an entry the patch cannot address answers through the live `entryId` its bundle row carries. A bound entry's card carries the row's live state and its switch — locked with the `readOnlyReason` text when the Host refuses to address the row, while the row key is busy, or without a management grant — stays listed while the row is off so the switch can bring it back, and repeats the switch plus the off or read-only reason on its own page. Entries sharing a `label` merge into one card bound to the group's live member, the idiom for a row whose id changes with the platform; the shell feature ships `bash-sandbox` and `pwsh-sandbox` under one label. An `id` no patch row or served namespace owns renders no card, so an uncomposed plugin still leaves no trace. The slot contract in `slot-contract.ts` owns this binding rule.

`PluginManagerState.plugins` publishes the running-profile entries from the same inventory read as `packages`, so binding resolution needs no second round trip. `ui-settings-plugins` registers its six cards unconditionally with patch-row ids (`bash-sandbox`, `pwsh-sandbox`, `agent-loop`, `subagent`, `subagent-model-selection-settings`, `web-search-deepseek`) instead of gating on `settingsScope.whileServed`; the voice-input bundle binds its `speech-to-text` row the same way. The group the cards sit in renames with the semantics — built-in features rather than plugin settings — and the experimental list becomes optional plugins.

This partially supersedes the served-namespace registration rule in [plugin configuration on the Plugins page](../architecture/2026-09-16-plugin-configuration-on-the-plugins-page.md) and the namespace-keyed card set in [the single-entry note](../simplification/2026-10-09-plugins-page-single-entry.md); both notes stay active and carry the updated facts. `settingsScope.whileServed` remains on the service for callers that still want served-namespace gating.

## Alternatives considered

**Keep namespace keys and the served filter.** A filtered card cannot express "listed while off," and a namespace key gives the card no row to switch; the affordance this change adds is impossible under that contract.

**Key cards on `entryId`.** Loader entry ids name module instances, not the stable patch row the Host's plugin-management API accepts, so the switch could not address the row; `entryId` survives only as the fallback for rows the patch cannot address.

**Two shell cards, one per platform row.** The two rows never coexist on one platform, so the pair would always render one dead card; merging on the shared label keeps a single affordance without a new grouping concept.

## Consequences

- Users switch built-in features — shell sandbox, agent loop, subagent, model selection, web search, and the speech-to-text bundle — from the Plugins page, and a switched-off feature keeps its card and switch.
- An entry whose id names no row degrades to a plain configuration card shown only while the Host serves a settings namespace of that id; community plugins keep that path.
- `ui-plugin-manager` gains the `PluginInfo` import from the remotes client contract; the page switches rows through the existing `setRowEnabled` action with the row-key busy channel.
- The basic-group card's `data-plugin-item` id now names a patch row, so it varies with the platform wherever rows do (`bash-sandbox` versus `pwsh-sandbox`); the label is stable.

## Testing

`components.client.spec.tsx` covers the bound card's switch and `setRowEnabled` call, an off feature staying listed with its page's off state, same-label merge preferring the live member with the all-off fallback, and the busy, read-only, and denied lock states with their reason text. `apply.client.spec.ts` pins the six unconditional registrations and their patch-row ids. The `plugin-config` web lane drives the same pages over the real wire and re-records its goldens with the switches and renamed groups.
