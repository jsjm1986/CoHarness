# Agent Note: Close the archived-selection races at connect and prompt admission

Status: implemented

English | [中文](2026-10-04-archived-selection-races.zh.md)

## Problem

Three gaps let a session archived while the client was away behave as a live conversation. The session list resolves before the Workspace archive baseline at reconnect, so a restored `dsh.sessions.current` id mounted with a live composer, and `session.prompt` admitted the input because nothing on either side refused an archived session. Once the baseline landed, the pooled aggregate masked `current` but the owning runtime kept its selection, so the per-runtime persistence projection re-saved the archived id and remounted the zombie on every reload; the Workspace-level sweep read the already-masked aggregate and could never fire for the restored case. `startInitialSelection` also skipped the archive-union recheck every sibling navigation commit performs.

## Decision

**Archive masking deselects at the owning runtime, and prompt admission is server-side.** In `SessionRuntimePool.rebuild`, an entry whose raw `current` lands in its target's archive set is deselected via `releaseSelection` — a narrower primitive than `clear` that drops the selection and the persisted cell without superseding an in-flight navigation intent. `session.prompt` refuses `session-archived` (the code `pinSession` already emits) when `workspaceRegistry.archivedSessionIds` contains the id, which makes the residual connect window harmless regardless of client state; minimal compositions without a Workspace Registry skip the check. `startInitialSelection`'s commit rechecks `archivedById`/`archivedSessionIds` before `sessions.open`, matching `selectWorkspace` and `uiWorkspace.openSession`.

## Files

- `packages/host/apiproxy/src/api-proxy.ts` — `session.prompt` archive admission returning `session-archived`.
- `packages/client/runtime/src/client/sessions/pool.ts` — `maskedSelections` collection and post-publish `releaseSelection`.
- `packages/client/runtime/src/client/sessions/service.ts` — `releaseSelection` beside `clear`.
- `packages/client/runtime/src/client/workspaces/service.ts` — archive-union recheck in the initial-selection commit.
- `packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`, `packages/client/runtime/tests/{session-pool,workspaces-service}.client.spec.ts` — prompt refusal, owner deselection, and mid-commit archive coverage.

## Consequences

A session archived elsewhere can no longer accept a prompt or remount after reload: the persisted selection cell clears when the baseline masks it, and the server refuses input during the connect window with a code the client already understands. In-flight navigation is never cancelled by masking — `releaseSelection` deliberately omits `beginNavigation`, so an initial selection racing an archive frame retries through its existing `waiting` path instead of deadlocking in `opening`. Read paths (`session.history`, attach) remain admitted on archived sessions; only input admission changed.
