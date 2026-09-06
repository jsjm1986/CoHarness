# Agent Note: Persistence handles follow Agent lifecycle ownership

Status: implemented

English | [中文](2026-09-06-session-handle-agent-lifecycle.zh.md)

## Problem

The persistence service had durable operations but no explicit owner for a Session writer. A resume or create path could therefore finish preparation without a lifecycle object that says who may append and when that ownership ends.

## Decision

`SessionPersistence` exposes read and write `SessionHandle`s. One persistence instance admits one write handle per Session id; read handles remain independent, and a read handle rejects append. `AgentFactory.createAgent` acquires a write handle before publication for fresh persistent sessions, while `resume` opens one after preparation. The handle is closed by the same memoized Agent teardown that drains the loop and unregisters the Session. Configuration-driven restore-or-create uses the same path; the synchronous in-memory `agentLoop.create` remains unchanged.

The current reservation is process-local and additive to the coordinator's existing per-id serialization. Cross-process file locking and the v2 on-disk migration use this ownership seam in later steps; they are not hidden inside a provider-specific compatibility shim.

## Alternatives considered

**Keep ownership implicit in `session/created` listeners.** Rejected because listeners observe a lifecycle but cannot identify the caller that owns a future write or reject a second writer before publication.

**Make the synchronous convenience `agentLoop.create` await persistence.** Rejected for this step because hundreds of assembled tests and in-memory examples use its synchronous contract; the async AgentFactory is the durable boundary already used by consumers.

**Add a separate lock protocol to each backend immediately.** Rejected because it would duplicate the lifecycle seam before the format migration defines lock recovery, stale-owner handling, and provider-specific atomicity.

## Consequences

Persistent Agent creation now fails before publication when another writer is already held, and successful teardown releases the id for reuse. Detached read consumers can use the same service without acquiring mutation rights. The handle currently delegates durability to the existing coordinator; it does not yet provide cross-process locking or automatic v2 conversion.

## Verification

Agent-loop lifecycle tests cover acquisition, rejection of a second writer, and release after `AgentHandle.dispose()`. Session-persistence handle tests cover read-only rejection, idempotent close, and local ownership.
