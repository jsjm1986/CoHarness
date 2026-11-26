# Agent Note: Verify Session durability during managed Runtime shutdown

Status: implemented

English | [中文](2026-11-20-managed-runtime-session-shutdown.zh.md)

## Problem

The Agent loop, Session persistence, and other profile plugins unload as siblings. Persistence can remove its live-event listener before an active Agent records `step/end` and `turn/end`. The process can stop successfully even though recovery must synthesize those missing events. A regular Agent dispose also clears accepted pending input, which a managed restart needs to retain.

## Decision

The [managed profile launcher](../../../../apps/cli/reference/README.md#managed-launch) closes Agent execution admission at the root before beginning teardown. The [Agent loop](../../../../packages/core/agent-loop/README.md#planned-shutdown) closes inbox submission and creation paths, cancels and joins active work, and waits for Agent scopes to release their producers. Each live Session then stops accepting appends, flushes with its storage listener still mounted, and verifies its final durable sequence through the persistence provider. Accepted human input awaiting a step or turn stays parked in the log. The launcher reports success to the supervisor after the checkpoint and profile disposal finish.

[Gateway](../../../../gateway/README.md#performance-and-runtime-admission) confirms process-range termination and Session durability separately. The local owner records a negotiated child result under the allocation lease. For systemd, the Runtime publishes a receipt signed with the exact generation's launch credential, and Gateway validates it after process termination. The project storage verifier uses current placement, writer rights, and write epoch for final appends and suffix reads of existing Sessions while the generation is stopping.

The local supervisor passes the stop budget to the managed Host over the inherited IPC channel. This lets an admitted checkpoint finish beyond the five-second signal fallback while the supervisor still forces process-range exit at its deadline. An orphan signal denied by the kernel leaves the Runtime occupied until a subsequent probe proves exit. The node drain applies its own deadline across all batches and reports incomplete evidence if that budget expires.

## Alternatives considered

Reordering bundle rows leaves sibling unload concurrent. A `turn/end` event or Agent `idle` notification proves local progress while persistence may still be pending. Awaiting the write handle's `close` alone can miss events when its routing listener has already detached. Moving every normal turn flush to a stronger synchronous checkpoint would add cost to model interaction without fixing teardown order.

## Consequences

The planned path spends part of its bounded stop window on backend readback and reports failure, timeout, or forced termination independently from process exit. Ordinary profile disposal keeps its current lifecycle. Unit tests hold an active request and a final checkpoint, then read the closed turn and queued inputs from JSONL in both mount orders. A real write refusal rejects the managed drain. The keyless Web CLI transcript checks IPC success, an authenticated signal receipt, checkpoint refusal, and failure logged by a scope disposer.
