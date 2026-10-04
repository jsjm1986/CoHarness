# Agent Note: Read pooled session archive state from the sessions partition plus the Workspace mirror

Status: implemented

English | [中文](2026-10-04-pooled-session-archive-consistency.zh.md)

## Problem

Session identity and archive membership split across two projections once the runtime pool keyed browser-side ids (`dsh-session:v1:<tuple>`) per target: `SessionListState.archivedById` merges every established runtime's archive set under qualified keys, while `WorkspaceListState.archivedSessionIds` mirrors one runtime's archive frame under wire ids. Consumers that read only the Workspace mirror misclassified project-runtime sessions — schedule links, workspace rows, navigation guards, the restore list, and workbench candidates all treated project archives as active. Companion gaps surfaced on the same surfaces: the pool never refreshed `archivedByTarget` on `host/archived-sessions-changed` frames or on the workspace-list repull inside `ensureSession`, `session.search` queried only the base target, `visibility`/`projectId` were dropped between the wire schema and `SessionListEntry`, `uiWorkspace.startSession` logged failures instead of producing the `createFailed` toast its renderer already owned, and the apiproxy fork route returned `session/fork-failed` instead of the cataloged `fork-failed` code.

Client archive projections govern presentation, not write admission: a mounted pane or stale reconnect baseline can submit input after the registry archives its session. Content conversion and execution stamping can suspend a request after its initial check, leaving an insertion race. Reading archive ids before awaiting ACL filtering and their revision afterward can publish an old set under a newer revision; revision-based clients may then reject the matching complete snapshot and retain incorrect archive membership.

## Decision

**Archive membership is the union of both sources, at every read site.** `archivedById` carries qualified keys for every pooled runtime; the Workspace mirror stays as the compatibility source for a non-pooled runtime whose sessions list keeps archived rows unpartitioned. `archivedSet` is a `derivePair` projection that subscribes to both lists so a Workspace-only repull still republishes. The pool updates `archivedByTarget` and rebuilds on archive frames and on `ensureSession` repulls, fans `search` out to every established target and re-keys each hit, and `sessionSummarySchema`/`SessionListEntry`/`flattenLineage` carry `visibility` and `projectId` so UI can route qualified keys without a second lookup. `IWorkspaces.startSession` accepts an optional `onFailure`; `uiWorkspace` formats structural RPC errors as `code: message` into `createFailed`. The fork route returns `fork-failed`.

**The executor owns archive admission.** `session.prompt` and the edit/steer actions of `session.updateQueue` consult `archivedInputError` before Agent resolution and again after asynchronous content conversion or execution stamping, rejecting archived targets with `session-archived` at the final synchronous admission before input insertion. Queue removal and cancellation remain available; compositions without `workspaceRegistry` have no archive set. `readableArchivedSessionSet` captures one `archiveSnapshot()` before asynchronous ACL filtering and returns that snapshot's revision with its filtered ids in `workspace.list`, `workspace.archiveSession`, and `workspace.unarchiveSession` replies.

## Files

- `packages/client/runtime/src/client/sessions/pool.ts` — archive frame/repull sync into `archivedByTarget`, multi-target `search` fan-out and re-keying.
- `packages/client/runtime/src/client/sessions/{manager,lineage,service}.ts`, `contract/{sessions-port,workspaces}.ts` — `visibility`/`projectId` propagation, `SessionsPortList.archivedById`, `startSession` failure callback.
- `packages/host/apiproxy/src/api/sessions.schema.ts` + `sessions.ts` — optional `visibility`/`projectId` on session summaries; `fork-failed` code.
- [Host ApiProxy](../../../../packages/host/apiproxy/src/api-proxy.ts) — executor archive admission and ACL-filtered archive snapshots.
- `packages/client/ui-workspace/src/client/{index,WorkspaceBrowser,shortcuts}.ts(x)` + `session-actions/derived.ts` — `derivePair` two-source `archivedSet`, union guards, `createFailed` toast wiring.
- `packages/client/ui-schedule/src/client/session-link.ts`, `ui-conversation/src/client/{apply,viewport}.ts`, `ui-settings-unarchive-sessions/src/client/ArchivedSessionsSection.tsx`, `ui-workbench/src/client/components/WorkbenchToolbar.tsx` — union archive reads.

## Alternatives considered

**Frontend-only or initial-only refusal.** Neither protects direct callers or requests suspended before insertion; the final synchronous executor check enforces the registry's current archive membership.

**Read archive ids and revision separately.** A revision read after ACL filtering can describe mutations absent from the captured ids, preventing revision-based clients from applying the missing membership update. Capturing both once keeps them consistent without holding the registry across authorization work.

## Consequences

Project-runtime sessions now archive/unarchive, label, link, and navigate identically to personal ones; a stale Workspace mirror can no longer resurrect an archived row. `search` covers every established runtime with qualified keys instead of silently scoping to the base target. Failed New Session requests surface as the existing `createFailed` toast with the stable `code: message` form. `pinnedSessionIds` remains a Workspace-domain list — pinning a project session is not offered anywhere the base mirror does not cover, which matches the current product surface.

An archive committed while an input request is suspended prevents insertion even when the caller retains an active pane or stale baseline; removal and cancellation can still reduce outstanding work. ACL-filtered replies may carry an older revision when the registry changes during filtering, but never label older ids with a newer revision. Clients can apply later complete snapshots without treating an incomplete archive set as current.
