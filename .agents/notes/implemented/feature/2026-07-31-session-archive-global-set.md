# Agent Note: Session archive (registry-global set)

Status: implemented

English | [中文](2026-07-31-session-archive-global-set.zh.md)

## Problem

The session row menu in the sidebar workspace browser carried a purely visual "Delete session" placeholder (no handler). The product decision is **archive**, not delete: the session log and its workspace accounting stay untouched; the session merely disappears from every grouping surface (workspace groups, Ungrouped, search, the flat list). The archive record needs a home: an Ungrouped session belongs to no workspace entity, so a per-workspace field cannot carry it.

## Decision

**The archive set is a new field on the workspace domain's global singleton (`workspaceDomainState.archivedSessionIds`), layered over workspace accounting; display filtering converges entirely in the client's `tree.ts` derivation layer; the wire surface uses the full-snapshot posture.**

- Storage: `archivedSessionIds: z.array(sessionId).default([])`, domain version stays 2 — a purely additive field; pre-field media parse to an empty set through the schema default, no migration code. An archived session keeps its `sessionIds` slot (a future unarchive restores its position), so the set never touches the one-owner accounting invariant.
- Registry: `ctx.workspaceRegistry.archiveSession(id)` rides `enqueueOperation`, serialized with create/delete; a session neither live nor persisted throws `WorkspaceUnknownSessionError`; an already archived id neither writes nor emits. The `archivedSessionIds` getter exposes the read-only set.
- RPC: `workspace.archiveSession({sessionId}) → {archivedSessionIds}` (answers the full updated set); the `workspace.list` response carries the set as the reconnect baseline; a new host frame `host/archived-sessions-changed` pushes the full snapshot after every durable change (same posture as `host/workspace-changed`, emitted from the `domain/changed` global-put branch by set comparison). Unknown sessions reuse the `session-not-found` error code.
- Client runtime: `WorkspaceListState.archivedSessionIds` (a `readonly SessionId[]` in Host order, reference replaced only on membership change — public snapshot state stays in the store engine's plain-data vocabulary since immer drafts reject Sets without the MapSet plugin; membership lookups build a transient Set in the derivation, the expandedProjects pattern); the list baseline, the unary echo, and the changed frame each carry a complete set, while the Client merges these append-only snapshots so a late shorter response cannot resurrect a row. The projection sweep clears the current selection whenever it lands in the archive set, returning to the New Session view (user decision: archiving the open session sends the main view back to the hero) — one rule covering the local unary echo, another tab's changed frame, and a reconnect baseline restoring a selection archived while this client was away. A future restore operation needs an explicit revision/reset protocol.
- UI: the `delete` menu row (visual-only) becomes `archive` (label "Archive session", non-danger styling, no confirmation dialog — a non-destructive action whose worst misfire is list hiding); filtering is one extra arm in `tree.ts`'s `sessionVisible` predicate, with `deriveGroups`/`deriveFlat` taking an `archived` set parameter so all four surfaces (group loop, stray bucket, search, flat) share one source.

## Alternatives considered

**Per-workspace archivedSessionIds (the original phrasing).** Rejected: Ungrouped sessions have no home; the user switched to global.

**An archived flag on SessionSummary (session.list layer).** Rejected: it joins a workspace-domain fact into the sessions-domain projection, summaries have no incremental frame so a separate notification would still be needed — cross-domain coupling outweighs the saving.

**Host-side filtering in `workspaceView`/the `sessionIds` getter.** Rejected: archiving ≠ changing accounting, and filtering the projection muddles the two concepts; a future restore surface also needs the client to see full accounting.

**Incremental frames (single archived/removed rows).** Rejected: the set is tiny and changes rarely; full snapshots keep the wire contract simple, while the Client's append-only merge handles carrier reordering without a second per-id protocol.

## Consequences

Regular Web clients still have no archive browsing or restore controls; the organization Admin channel now owns cross-runtime viewing and restore through the versioned snapshot/reset path. Data and accounting slots stay intact until an explicit lifecycle purge. The `workspace.list` response shape change is a pre-release direct edit (no compatibility layer). The workspace-management e2e pins the archive hide/reconnect chain; domain tests pin idempotence, unknown-id rejection, restart recovery, restore revision handling, and the pre-field media default upgrade. The [Admin archive channel note](2026-08-25-admin-archive-channel.md) owns the Gateway index and lifecycle rules. The [empty-content and archive-ordering note](../bug-fix/2026-08-25-session-list-empty-content-and-archive-ordering.md) records the reordering fix.
