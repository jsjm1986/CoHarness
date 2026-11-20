# Agent Note: Admin cross-space plugin inventory

Status: implemented

English | [中文](2026-11-17-admin-cross-space-plugin-inventory.zh.md)

## Problem

`/admin/plugins` could manage plugins for one space at a time, but an administrator could not answer "what is installed across every personal and project space on this computer" without opening each space while its runtime was live. `plugin_states` holds only the administrator-saved desired composition (managed rows and bundle names — no versions, install sources, or load outcomes), covers only spaces an administrator has overridden, and is never written for file-driven or steward spaces. The live `pluginInventory/list` remote answers only while the instance runs and only per-space. User- and project-authored plugins (local `file:`/`link:` paths, git specs, tarballs) were therefore invisible as a set, and "who installed plugin X" had no answer.

## Decision

Persist a runtime-reported **observed inventory** per space and render it in the existing `/admin/plugins` page as the opening cross-space section.

**Storage.** `harness.plugin_inventory` (migration 139) and `node_content.plugin_inventory` (migration 017) hold one row per runtime identity: `payload` jsonb, `generation`, `updated_at`. The table is observed data, deliberately split from `plugin_states` desired state — an administrator's document and a runtime's observation must not share a lifecycle. Governance rebuild marks `organization_id,runtime_id` restore-safe and `payload,generation,updated_at` node-owned; `peerProjectTables` and the content-migration relation map carry the node-content copy so project moves and takeover keep the last report.

**Reporting.** `PluginManagementAuthorization` gains optional `reportInventory(snapshot)`; `PluginInventoryReport` is exactly the `BundleInfo[]` + `PluginInfo[]` catalog projections — localized titles, install sources, lifecycle phases included — so the Admin UI renders the same cards users see, not a second format. `gateway-execution` forwards it to `POST /internal/runtime/plugin-inventory`. `PluginManager` schedules a report once startup settles, after every committed change (serialized behind the desired-state publish through `syncTail`), and when a burst of loader-entry `internal/status` transitions quiets (1 s debounce); failures warn and never block management. Disposal clears the pending timer.

**Gateway.** `PostgresPluginInventory.report` re-uses `resolvePluginRuntimeOwner` — the instance row must still match the credential's owner, runtime, node, and generation, so a stale process cannot overwrite its successor — then upserts into harness or node_content per the owner's content binding. Wire parsing bounds counts, strings, icons, and drops unknown fields. `GET /admin/api/plugins/inventory` lists every instance row on this node (user, project, steward; never just spaces holding `plugin_states`), joined with the last report and the saved desired composition; a corrupt stored payload degrades to absent rather than hiding the space. Reads never start stopped runtimes.

**Presentation.** `SpacesInventory` renders one expandable card per space: running/stopped, report time, bundle/entry/failed counts, bundle cards with localized titles and provenance badges (built-in, npm, git, local/self-developed, archive), declared rows joined to live fiber phases, and a `SavedComposition` fallback clearly labeled as saved-not-observed. A filter matches space names, bundle and module names, and localized titles, answering "who installed X" in v1. The manage button binds the existing target picker; steward rows stay read-only through the existing policy.

## Alternatives considered

- **Live fan-out over the management invoke channel** — rejected: it only covers online runtimes, performs N lease-bound calls per page load, and uses the write channel for a read-only question. Persisted observation answers for stopped and never-managed spaces at one query cost.
- **Extend `plugin_states` with an observed payload** — rejected: that table is an administrator-edited document under optimistic revision where clearing a row deletes it ([desired-state projection](../architecture/2026-10-03-plugin-desired-state-projection.md)); mixing a runtime-owned observation would tie its lifecycle to admin edits and confuse "desired" with "actual".
- **Report a reduced summary (names and counts only)** — rejected: administrators read localized titles, versions, sources, and phases; a second presentation model would need its own display pipeline, while the full `BundleInfo`/`PluginInfo` catalog costs only a slightly larger payload and reuses the existing render vocabulary.
- **Per-plugin ACL as part of this change** — rejected: qualification stays space-level (`plugin_access_policies`); a plugin-name allow-list is a separate authorization design, not observability.

## Consequences

- Every gateway-managed runtime — including spaces that never open the plugin manager and the resident steward — records its composition after startup and each change, so `/admin/plugins` shows actual loaded state for the whole node.
- A space with no report still appears with its saved desired composition labeled as such; the two sources are never conflated.
- Report failures degrade to warnings in the runtime; the admin view shows the last stored observation with its timestamp, never an empty page.
- Content-placed projects report and list through their node-content volume; harness rows stay keyed by `(organization_id, runtime_id)`.
- Stale-generation or mismatched publications reject with 409 inside the owner-resolution check; payload size stays bounded at the wire parser and the 1 MiB request-body limit.

## Verification

- `gateway/tests/plugin-inventory.spec.ts` covers wire validation, report/list round-trip, stale-generation rejection, and the saved-state fallback for an unreported project (PostgreSQL suite).
- `packages/boot/plugin-manager/tests/manager.spec.ts` covers the startup report, the post-change report, and unreachable-store degradation.
- `packages/context/gateway-execution/tests/plugin-management.spec.ts` covers the forwarding contract.
- `gateway/admin-ui/src/plugins/SpacesInventory.spec.tsx` covers listing, expansion, provenance and phase badges, filtering, and target binding.
