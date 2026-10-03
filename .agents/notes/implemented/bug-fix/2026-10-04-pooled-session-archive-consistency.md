# Agent Note: Read pooled session archive state from the sessions partition plus the Workspace mirror

Status: implemented

English | [中文](2026-10-04-pooled-session-archive-consistency.zh.md)

## Problem

Session identity and archive membership split across two projections once the runtime pool keyed browser-side ids (`dsh-session:v1:<tuple>`) per target: `SessionListState.archivedById` merges every established runtime's archive set under qualified keys, while `WorkspaceListState.archivedSessionIds` mirrors one runtime's archive frame under wire ids. Consumers that read only the Workspace mirror misclassified project-runtime sessions — schedule links, workspace rows, navigation guards, the restore list, and workbench candidates all treated project archives as active. Companion gaps surfaced on the same surfaces: the pool never refreshed `archivedByTarget` on `host/archived-sessions-changed` frames or on the workspace-list repull inside `ensureSession`, `session.search` queried only the base target, `visibility`/`projectId` were dropped between the wire schema and `SessionListEntry`, `uiWorkspace.startSession` logged failures instead of producing the `createFailed` toast its renderer already owned, and the apiproxy fork route returned `session/fork-failed` instead of the cataloged `fork-failed` code.

## Decision

**Archive membership is the union of both sources, at every read site.** `archivedById` carries qualified keys for every pooled runtime; the Workspace mirror stays as the compatibility source for a non-pooled runtime whose sessions list keeps archived rows unpartitioned. `archivedSet` is a `derivePair` projection that subscribes to both lists so a Workspace-only repull still republishes. The pool updates `archivedByTarget` and rebuilds on archive frames and on `ensureSession` repulls, fans `search` out to every established target and re-keys each hit, and `sessionSummarySchema`/`SessionListEntry`/`flattenLineage` carry `visibility` and `projectId` so UI can route qualified keys without a second lookup. `IWorkspaces.startSession` accepts an optional `onFailure`; `uiWorkspace` formats structural RPC errors as `code: message` into `createFailed`. The fork route returns `fork-failed`.

## Files

- `packages/client/runtime/src/client/sessions/pool.ts` — archive frame/repull sync into `archivedByTarget`, multi-target `search` fan-out and re-keying.
- `packages/client/runtime/src/client/sessions/{manager,lineage,service}.ts`, `contract/{sessions-port,workspaces}.ts` — `visibility`/`projectId` propagation, `SessionsPortList.archivedById`, `startSession` failure callback.
- `packages/host/apiproxy/src/api/sessions.schema.ts` + `sessions.ts` — optional `visibility`/`projectId` on session summaries; `fork-failed` code.
- `packages/client/ui-workspace/src/client/{index,WorkspaceBrowser,shortcuts}.ts(x)` + `session-actions/derived.ts` — `derivePair` two-source `archivedSet`, union guards, `createFailed` toast wiring.
- `packages/client/ui-schedule/src/client/session-link.ts`, `ui-conversation/src/client/{apply,viewport}.ts`, `ui-settings-unarchive-sessions/src/client/ArchivedSessionsSection.tsx`, `ui-workbench/src/client/components/WorkbenchToolbar.tsx` — union archive reads.

## Consequences

Project-runtime sessions now archive/unarchive, label, link, and navigate identically to personal ones; a stale Workspace mirror can no longer resurrect an archived row. `search` covers every established runtime with qualified keys instead of silently scoping to the base target. Failed New Session requests surface as the existing `createFailed` toast with the stable `code: message` form. `pinnedSessionIds` remains a Workspace-domain list — pinning a project session is not offered anywhere the base mirror does not cover, which matches the current product surface.
