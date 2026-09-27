# Agent Note: Session unarchive — wire inverse and the Archived sessions Settings page

Status: implemented

English | [中文](2026-09-25-session-unarchive-restore-surface.zh.md)

## Problem

The registry-global archive set had a write path (`workspace.archiveSession` + `archiveSession` on the client object layer) but no user-facing inverse: an archived session stayed hidden until an organization administrator restored it through the Gateway archive channel. Upstream alignment added `workspace.unarchiveSession` plus a Settings page as the self-service restore surface.

## Decision

**Unarchive reuses the archive wire and client semantics rather than growing a parallel protocol.**

- RPC: `workspace.unarchiveSession({sessionId}) → {archivedSessionIds, archiveRevision?}` mirrors the archive signature — same full-snapshot answer, same `host/archived-sessions-changed` frame, same visibility filtering. It is idempotent at the handler level: `workspaceRegistry.restoreSession` already returns silently for an id outside the set, so a lost race with another surface resolves with the current snapshot instead of an error.
- Registry: `restoreSession` bumps `archiveRevision` on removal just as `archiveSession` does on append, so the client's versioned install path replaces the set wholesale — the merge path is reserved for unversioned legacy carriers, where union is the safe append-only default. A shrinking unversioned echo would be swallowed by that merge, which is why the fixture now tracks `archiveRevision` like the real host.
- Client: `IWorkspaces.unarchiveSession` delegates to the manager, which installs the echoed set; no selection sweep is needed because an archived session was never current.
- UI: a new `ui-settings-unarchive-sessions` plugin contributes one `settings.section` (id `archived-sessions`, order 25 — last) listing the archive set newest-first joined with loaded Session summaries, with a search box and one Unarchive button per row. Members whose summary never loads have no row; an all-unresolvable set reports itself as unrestorable rather than empty. The plugin injects `workspaces` directly — there is no navigation coupling on restore, so the upstream `ctx.uiWorkspace` indirection has no local counterpart.
- `relativeTime` moved from `ui-workspace`'s tree derivation to `ui-primitives` so the sidebar rows and the settings page share one bucketing; copy stays in each plugin's dictionary.

## Alternatives considered

**A new per-id incremental protocol.** Rejected for the same reason the archive side rejected it: the set is tiny and every carrier already answers the full snapshot.

**Sidebar row-menu unarchive.** Rejected: archived rows are hidden from the tree by definition, so there is no row to hang the action on; the Settings page is the only restore surface, matching upstream.

## Consequences

Personal-scope users can now self-restore; the Gateway Admin archive channel keeps its distinct organization-scoped role (cross-runtime viewing, trash window, purge). Deleting a session record remains a separate capability the settings page does not offer. Restores bump `archiveRevision` on the same counter as archives, so all revision-ordering guarantees hold unchanged. The [session archive global-set note](2026-07-31-session-archive-global-set.md) owns the set's storage and merge semantics; the [Admin archive channel note](2026-08-25-admin-archive-channel.md) owns the organization-scoped index.
