# Agent Note: Live curation switches own independent operation lifetimes

Status: implemented

English | [中文](2026-10-31-memory-curation-live-availability.zh.md)

## Problem

Extraction and consolidation can wait for storage, model preparation, capacity or a tool result. Checking settings only when a pass starts allows a disabled operation to dispatch another request and mark its review complete. A single Session-wide cancellation controller cannot cancel extraction independently of consolidation or preserve a queued turn while the cancelled operation cleans up.

## Decision

A Session lane retains its disposal controller and coalesced turn queue. Its currently running extraction or consolidation operation owns a separate controller linked to the lane. A change in effective memory switches cancels only operations whose own switch or the master switch is off. The lane waits for their model and storage cleanup before starting another operation. Cancelling extraction permits still-enabled consolidation to run; subsequent turns re-read current switches.

Storage completion, model preparation, every model round, each tool result and completion-cursor admission recheck the operation's current switches and offered scope addresses. Unavailable work stops before another request is logged or dispatched and does not publish completion progress. Signals continue through existing LLM admission and cursor queues, so late grants release without invoking an adapter and a cancelled queued cursor cannot commit. Already admitted durable writes retain their normal outcome and are not rolled back.

This extends the [live memory availability rule](2026-10-31-memory-live-availability.md). Exact request records remain governed by [auxiliary request ownership](2026-10-24-memory-auxiliary-ownership.md), tool addresses by the [curation scope restriction](2026-10-28-memory-curation-scope.md), and concurrent review/cursor arbitration by [scope coalescing](2026-10-31-memory-consolidation-coalescing.md).

The memory service owns [source-change notification](2026-11-01-memory-provider-availability.md) for both namespace commits and provider lifetimes; the operation reads its own injected service before cancelling.

## Alternatives considered

**Abort the entire Session lane when either switch turns off.** This also cancels an independently enabled operation and discards scheduling ownership needed to drain the queued turn safely.

**Check only before the first model call.** A storage or tool result can finish later, and a prepared request can still be waiting for capacity. Each new dispatch and progress commit requires current availability.

**Return from cancellation before provider cleanup.** That allows a replacement review to spend resources while the old provider still owns its request. The existing lane completion remains the shutdown acknowledgement.

## Consequences

Disabled curation consumes no newly admitted model round and leaves its unfinished review eligible for a later enabled pass. Owner reads, committed memory entries and prior request records remain available. No settings key, Session event format, storage record, policy grant or resource limit changes. Project qualification and captured-issuer checks follow the [curation authorization decision](2026-11-01-memory-curation-authority.md); broader project revocation review remains open.

## Verification

Delayed catalog and entry reads reproduce post-withdrawal dispatch; delayed tool reads and searches reproduce a subsequent model round. Metadata, preparation, late model grants and queued cursors have focused cases. Independent-switch cases retain enabled consolidation. Real SDK processes commit file settings during an actual auxiliary call, observe cancellation before shutdown and join provider iterator cleanup before releasing its permit. Complete private old packages fail the unchanged SDK checks; normal curation and request-projection fixtures remain regression coverage.
