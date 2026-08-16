# Agent Note: Admit the plugin inventory Remote in project scope

Status: implemented

English | [中文](2026-08-17-project-scope-plugin-inventory-remote.zh.md)

## Problem

`authorizeTypertRemote` applied project collaboration ACLs by classifying each Typert Remote endpoint in `PROJECT_TYPERT_SESSION_AUTHORIZATION`, a table whose every row extracts a Session identity and authorizes against that conversation's root ACL. Any endpoint absent from the table fell through to a `manage`-class refusal, so in a shared project runtime `pluginInventory/list` — a read-only projection of the Loader with no Session identity — returned `collaboration-forbidden` for every participant, including administrators. The Web Settings → Plugins → Plugin list tab surfaced this as "Plugins are temporarily unavailable" in project scope while the same tab worked in personal scope.

## Decision

A second, explicitly read-only classification now exists beside the session table: `PROJECT_TYPERT_PROCESS_WIDE_READS` admits `pluginInventory/list` in project scope without a session ACL. Project membership is already established when the signed request principal is captured — the runtime verifies organization, user, scope, runtime id, and generation before Host code observes the request — so `ro` and `rw` members alike may read process-wide diagnostic state that mutates nothing and carries no conversation content. Unclassified endpoints keep the default `manage` refusal; the deny test now uses `commands/execute`, a real mutating process-wide Remote that must stay refused.

## Alternatives considered

**Classify `pluginInventory/list` inside the session table.** Rejected because the table's contract requires a Session identity extractor and a per-conversation ACL; a process-wide read has neither, and a synthetic session would authorize the wrong resource.

**Deny the Remote and hide the Plugin list tab in project scope.** Rejected because the Loader inventory is diagnostic state of the shared runtime every member is already attached to; hiding it makes project sessions harder to inspect without removing any real secrecy.

**Admit all `list`-shaped Remotes by naming convention.** Rejected because endpoint names do not encode a resource or mutation class; `commands/list` and `dynamicCordisRunner/inventory` need individual classification decisions before admission.

## Consequences

Adding a process-wide Remote that should stay project-visible requires an explicit entry in `PROJECT_TYPERT_PROCESS_WIDE_READS`; omission keeps the fail-closed default. Session-scoped Remotes continue to route through `PROJECT_TYPERT_SESSION_AUTHORIZATION` unchanged. `commands/execute` and the `dynamicCordisRunner/*` surface remain unclassified and are denied in project scope until individually classified.
