# Agent Note: Persistence handles follow Agent lifecycle ownership

Status: implemented

English | [中文](2026-09-06-session-handle-agent-lifecycle.zh.md)

## Problem

The persistence service had durable operations but no explicit owner for a Session writer. A resume or create path could therefore finish preparation without a lifecycle object that says who may append and when that ownership ends.

## Decision

`SessionPersistence` exposes read and write `SessionHandle`s. One persistence instance admits one write handle per Session id; read handles remain independent, and a read handle rejects append. `AgentFactory.createAgent` acquires a write handle before publication for fresh persistent sessions, while `resume` opens one before reading or repairing the stored session. The handle is closed before registry detachment by the same memoized Agent teardown that drains the loop, releases durable ownership, and unregisters the Session. Configuration-driven restore-or-create uses the same path; the synchronous in-memory `agentLoop.create` remains unchanged.

The current reservation is process-local and additive to the coordinator's existing per-id serialization. The JSONL provider also holds an atomic root lock for the lifetime of a write handle, while SQLite and Gateway providers retain their own provider-specific ownership rules. Format migration uses the same lifecycle seam and never runs without write ownership.

## Alternatives considered

**Keep ownership implicit in `session/created` listeners.** Rejected because listeners observe a lifecycle but cannot identify the caller that owns a future write or reject a second writer before publication.

**Make the synchronous convenience `agentLoop.create` await persistence.** Rejected for this step because hundreds of assembled tests and in-memory examples use its synchronous contract; the async AgentFactory is the durable boundary already used by consumers.

**Add a separate lock protocol to each backend immediately.** Rejected because it would duplicate the lifecycle seam before the format migration defines lock recovery, stale-owner handling, and provider-specific atomicity.

## Consequences

Persistent Agent creation and resume now fail before publication when another writer is already held, and successful teardown releases the id for reuse. Closing the handle before registry detachment prevents a replacement configuration from racing the previous lifecycle's final durable drain. Detached read consumers can use the same service without acquiring mutation rights. JSONL resume and provider migration preserve the source generation while publishing the current format.

## Verification

Agent-loop lifecycle tests cover acquisition before resume reads, rejection of a second writer, close-before-detach teardown ordering, abandoned opens, and release after `AgentHandle.dispose()`. Session-persistence handle tests cover read-only rejection, idempotent close, and local ownership; JSONL tests cover the cross-process lock and legacy-generation publication.
