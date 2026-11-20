# Agent Note: Keep independent Web plugins out of application startup

Status: implemented

English | [中文](2026-11-20-web-plugin-startup-isolation.zh.md)

## Problem

The Web kernel audited the complete plugin roster before handing off to the renderer. An unavailable Settings extension could leave the chat UI stuck on the boot page. Preloading application combos also fetched independent extension bytes before the first render.

## Decision

The [client module registry](../../../../packages/client/modules/README.md) treats `dsh.client.optional: true` as an opt-in for independent application plugins. Bootstrap, entries with the default declaration, and all their transitive `inject` and `external` dependencies are required. The Host isolates each remaining optional entry in its own application batch. The browser uses single-entry URLs when a received combo would otherwise mix optional and required delivery.

The [Web kernel](../../../../packages/client/web/README.md) audits required entries before mounting the renderer. The renderer's mount fiber schedules optional entries for a later browser task. The [page-owned controller](2026-09-23-page-owned-client-entries.md) starts bounded optional script requests outside its mutation queue. It schedules Loader mutations after the necessary factories register and reports each optional failure in Plugins. Graph changes, retries and disposal cancel superseded arrivals. A cancelled classic script can still execute, so the module system checks its lifetime at registration. The [Settings plugin inventory](../../../../packages/client/ui-settings-plugin-inventory/README.md) opts in and loads its inventory when the user selects the tab. The session, connection, and composer retain the required services and authorization checks.

## Alternatives considered

**Defer only feature bodies.** Useful for a required plugin that provides shared services or slot declarations, but an entry fetch or activation failure would still block the whole roster.

**Allow startup with any failed entry.** A failure in the connection, session, or workspace composition must remain visible and prevent mounting a partial required application.

## Consequences

An unavailable optional entry leaves the core application available. A dependent becomes required when a required consumer declares an edge to it. Optional entries arrive at low request priority after mount, and an on-demand chunk uses the browser's normal priority.
