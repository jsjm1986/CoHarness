# Agent Note: Pin whole-set Workspace echoes to the mirrored runtime

Status: implemented

English | [中文](2026-10-04-workspace-mirror-foreign-echo-guard.zh.md)

## Problem

`workspace.archiveSession`/`unarchiveSession`/`pinSession`/`unpinSession` return the mutated registry's complete id set, and the session-addressed api routes the request to the session's owning runtime — correct request direction. `WorkspaceManager` then unconditionally installed the returned set into the base-scoped mirror: a foreign runtime's archive/pin echo wholesale-replaced the base sets (re-keyed into wrong qualified ids, pin markers lost), and a foreign `archiveRevision` larger than the local counter froze every later base `archived-sessions-changed` frame at the revision gate. Companion defect: `archiveSession`'s synchronous pin-drop filtered raw stored ids against the caller's qualified key, so it silently no-opped in pooled mode.

## Decision

Whole-set unary echoes install only when the mutated session owns to the runtime this manager mirrors. `WorkspaceManager` accepts a `localSession(id)` predicate (default always-true for the single-runtime construction); `WorkspaceRuntime` supplies `sessions.runtimeTargetFor(id) === undefined`, the pool's base-ownership answer, and `SessionsPort` widens by that member — the contract file's documented widening seam. The pin-drop compares the de-qualified wire id against the raw stored set. A foreign mutation still returns its result to the caller; the owning runtime's own `archived-sessions-changed`/pool `archivedByTarget` path carries the truth for that target.

## Files

- `packages/client/runtime/src/client/workspaces/manager.ts` — `localSession` guard on all four whole-set installs; de-qualified pin-drop comparison.
- `packages/client/runtime/src/client/workspaces/service.ts` — predicate wired to `sessions.runtimeTargetFor`.
- `packages/client/runtime/src/client/contract/sessions-port.ts` — `runtimeTargetFor` added to the port's Pick.
- `packages/client/runtime/tests/workspaces-service.client.spec.ts` — foreign-echo rejection and qualified-key pin-drop coverage.

## Consequences

Pin/archive mutations on project-runtime sessions no longer clobber the base mirror's sets or its archive revision; the foreign registry's echo is discarded by the mirror while remaining authoritative for its own runtime's pool partition. The residual gap stays documented: a foreign runtime's `pinned-sessions-changed` frame still has no consumer, so pinning is only meaningful where the base mirror covers it — unchanged product surface.
