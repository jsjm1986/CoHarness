# Agent Note: Persistence handles follow Agent lifecycle ownership

Status: implemented

English | [中文](2026-09-06-session-handle-agent-lifecycle.zh.md)

## Problem

The persistence service had durable operations but no explicit owner for a Session writer. A resume or create path could therefore finish preparation without a lifecycle object that says who may append and when that ownership ends.

## Decision

`SessionPersistence` exposes read and write `SessionHandle`s. One persistence instance admits one write handle per Session id; read handles remain independent, and a read handle rejects append. `AgentFactory.createAgent` acquires a write handle before publication for fresh persistent sessions, while `resume` opens one after preparation. The handle is closed by the same memoized Agent teardown that drains the loop and unregisters the Session. Configuration-driven restore-or-create uses the same path; the synchronous in-memory `agentLoop.create` remains unchanged.

The abstract reservation is process-local and additive to the coordinator's existing per-id serialization. JSONL now layers a root-scoped atomic lock file through `openHandleAsync`, while Gateway and SQLite retain their backend-specific transaction ownership. The v2 on-disk migration uses this ownership seam rather than a provider-specific compatibility shim.

## Alternatives considered

**Keep ownership implicit in `session/created` listeners.** Rejected because listeners observe a lifecycle but cannot identify the caller that owns a future write or reject a second writer before publication.

**Make the synchronous convenience `agentLoop.create` await persistence.** Rejected for this step because hundreds of assembled tests and in-memory examples use its synchronous contract; the async AgentFactory is the durable boundary already used by consumers.

**Add a separate lock protocol to each backend immediately.** Rejected as the public API contract; providers may add their own atomic lock behind `openHandleAsync`, but the lifecycle seam remains shared and the lock recovery policy stays provider-specific.

## Consequences

Persistent Agent creation now fails before publication when another writer is already held, and successful teardown releases the id for reuse. JSONL rejects a second process through its atomic lock file and removes a lock whose recorded PID is no longer alive; unreadable or live locks remain blocking. Automatic v2 conversion remains provider-specific follow-up work. Detached read consumers can use the same service without acquiring mutation rights, and the handle delegates durability to the existing coordinator.

## Verification

Agent-loop lifecycle tests cover acquisition, rejection of a second writer, and release after `AgentHandle.dispose()`. Session-persistence and JSONL tests cover read-only rejection, idempotent close, local ownership, live/dead cross-process locks, and release.
