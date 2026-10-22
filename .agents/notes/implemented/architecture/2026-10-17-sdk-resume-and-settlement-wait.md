# Agent Note: SDK session resume and settlement wait on the wire

Status: implemented

English | [中文](2026-10-17-sdk-resume-and-settlement-wait.zh.md)

## Problem

The SDK JSON-RPC surface created sessions only implicitly: `session/prompt` minted whatever `sessionId` it was handed when no live agent owned it. Two lifecycle needs had no wire expression. A client whose runtime restarted could not reattach to a persisted identity — prompting under the old id fabricated a fresh empty history while claiming the old name, and anything that was not resumable silently became a new session instead of an error. A client also could not observe settlement: `session/prompt` resolves when the request is accepted, and the `session.event` notification stream never states that a turn, including turns still running inside delegated descendants, has finished.

## Decision

`session/resume { sessionId }` reattaches a live agent to a persisted session without sending a model request. The server restores through `ctx.agents.resume({ resumeSessionId })`, so the exact persisted identity, header, and event history carry over, subsequent turns continue the log's own numbering, and appends land on the same log generation. Resume rejects a missing, unreadable, incompatible, or already-open identity rather than silently creating one — a lookup failure must not fabricate an empty history under a real name. A resumable-but-interrupted log is repaired on load, which is a persistence-layer property the wire operation inherits unchanged.

`session/wait { sessionId }` settles a session from the client's side: it waits for the root agent's idle point, then joins `ctx.subagents.waitForChildren` so delegated work still running under the root counts toward settlement, and re-checks the root's sequence afterward so a late child-triggered turn cannot slip the wait past the events that turn emitted. The server records live agent failures from `agent/error` at their `SessionLogOffset`; a wait surfaces the recorded failure unless a terminal `turn/end` at or beyond that offset superseded it, so a stale failure does not poison later healthy turns.

Both operations route through `assertLiveAgent`, and the server keeps a `SessionRecord` per session it owns — prompt, wait, resume, and working-directory operations share one liveness path. Explicit restoration goes through `openSession(sessionId, 'resume')`, kept distinct from prompt-time creation. Shutdown drains `drainContinuableDescendants` before disposing root agents so no root is torn down while a child it hosts can still append.

## Alternatives considered

**Resume implicitly inside `session/prompt`.** Treating an unknown id as "restore if persisted, else create" erases the difference between reattach and create; a mistyped id would mint a fresh session under a name the caller believes is historical.

**Replay history through a new prompt.** Re-sending prior content cannot preserve the log, the identity, or turn numbering — it constructs a different session that happens to contain the same text.

**Client-side settlement by polling `session.event`.** The event stream lacks descendant liveness and the failure offset; whether a session has settled is a server-side fact the client cannot reconstruct.

**A `session/resumed` boundary event on load.** The persistence layer already rejected a load-minted marker: it is a durable write on a read path and covers no fork ([session end-seed log boundary](2026-07-30-session-end-seed-log-boundary.md)).

## Consequences

- The TypeScript SDK exposes `resumeSession(sessionId)` on `DeepSeekHarness`/`HarnessClient`; the Python SDK exposes `resume_session(session_id)`. `session/wait` is a server method consumed by the SDK test surfaces and shutdown ordering, not a client convenience.
- The wire result for both operations is `Record<string, never>`: acknowledgement is positional, facts live in the session log and the agent's state.
- `packages/sdk/server/tests/{resume,wait,shutdown}.spec.ts` compose real `Context` + `JsonlSessionPersistence` + `AgentLoop` and pin restoration identity, append-only continuation, failure propagation, pending-restore sharing, shutdown draining, and rejection paths.
- The `session-resume` entry in `snapshots/sdk/` replays a runtime restart against a persisted fixture, proving restored history reaches the first post-resume model request.
- `scripts/smoke-python-runtime.py` exercises restart plus resume against the packaged runtime, verifying no model request fires before new input and the persisted log stays append-only across turns 1 and 2.
