# Agent Note: Admin archives can settle records whose runtime cannot confirm

Status: implemented

English | [中文](2026-10-18-archive-unreachable-runtime-settle.zh.md)

## Problem

Archive lifecycle commands (`restore`, `trash`, `purge`) are durable queue rows that only an owning runtime consumes: the runtime polls `/internal/runtime/archive/pending`, pushes its snapshot, replays the returned commands, and acknowledges. When the owning runtime never starts again — a stopped project runtime is the observed case — the command pends forever. The Admin record then stays `sync_state='pending'` indefinitely, `setState` refuses with `archive-purge-pending`, and `purge` returns early on the existing pending row, so no administrator action can finish the record. Separately, empty-draft maintenance wrote `record_kind='empty-draft'` rows in `trash` state, but the records list always queried `recordKind='conversation'` and the `message_count > 0` clause hid zero-count rows anyway, so trashed drafts were unreachable from every archive view.

## Decision

`ConversationArchiveService.settle` finishes a record whose commands can no longer reach their runtime. A pending purge executes `purgeStoredTree` against Gateway-stored data, marks that command applied, and the record becomes `purged`/`synced`; pending restore or trash commands are retired `failed` with an unconfirmed note and the record shows `conflict` so the divergence stays visible. The action is exposed as a `settle` archive action audited as `admin.archives.settle`.

A purged record that a runtime re-announces re-queues a purge command inside `syncSnapshot`, so a runtime returning later still removes its surviving local copy instead of holding an orphaned archive the Gateway can no longer see.

The administrator list now queries `recordKind='all'` and the zero-message exclusion only hides rows with `record_kind='conversation'`, keeping empty-draft records visible under `trash` and `all` with a dedicated badge.

## Alternatives considered

**Time out pending commands automatically.** Rejected: a runtime legitimately offline for days still deserves its queue, and an automatic deadline would silently change lifecycle semantics; settle keeps the timeout decision an explicit, audited administrator choice.

**Force every pending action to `synced`.** Rejected: marking an unapplied restore or trash applied would claim runtime state the Gateway never verified; conflict keeps the residual divergence honest.

**Start the runtime to deliver the command.** Rejected for this change: pulling a stopped runtime up just to apply archive bookkeeping couples Admin maintenance to runtime lifecycle and its startup side effects.

## Consequences

Administrators can close permanently stuck archive records from a stale row, the detail dialog, or the batch bar; the 24-hour-stale pending label and the settle confirmation explain what is happening to data on each side. Runtime-local copies of a settled purge are not deleted by the settle itself — they are removed by the re-queued purge at the runtime's next snapshot, and a runtime that never returns keeps its residue, which the record no longer tracks.
