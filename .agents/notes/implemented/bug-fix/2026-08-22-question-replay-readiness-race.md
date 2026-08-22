# Agent Note: Question replay waits for connection readiness

Status: implemented

English | [中文](2026-08-22-question-replay-readiness-race.zh.md)

## Problem

When a browser connection was re-established while `ask_user_question` was waiting, the host replayed the still-pending question on the mux stream as soon as that stream opened. The client then ran its reconnect resync after the readiness handshake, and resync cleared the session's pending waits. Depending on scheduling, the replayed question could therefore appear briefly and then disappear without a second replay, leaving the model blocked and the user unable to answer.

## Decision

`ConnectionController` buffers mux and host frames for each connection generation until the describe-and-stream readiness handshake has completed and the `onConnected` consumer callback has returned. It then releases the buffered frames in arrival order. A failed or stopped generation drops its buffer. This ordering lets session consumers clear stale generation state before they receive replayed pending interactions, while preserving the existing host-owned pending question and stable rpcId semantics.

## Alternatives considered

**Keep replay delivery before `onConnected` and change `Session.resync`.** Rejected: resync would need a second protocol-level baseline to distinguish a replayed request from a request resolved while disconnected. The connection generation already has a readiness callback, so ordering at that seam is smaller and applies equally to approvals and other replayed state.

**Delay only question and approval frames.** Rejected: partial buffering would leave session history, queue, and interaction frames observable in different generations and would make ordering dependent on frame type. A single generation buffer keeps all host and mux projections on one readiness boundary.

**Ignore the replay until the next reconnect.** Rejected: it loses the only live answerable frame for a pending question and leaves the agent blocked.

## Consequences

Replayed pending questions and approvals are no longer removed by the reconnect resync race. Frames received during a failed handshake are discarded instead of mutating client state from a dead generation. The readiness window can retain a small amount of stream data in memory, but it is bounded by the handshake and is released immediately after the consumer callback.

## Testing

The connection lifecycle suite now asserts that a frame delivered before the describe response reaches the mux sink only after `onConnected`. Existing connection, session, and manager interaction tests remain green. The browser question-composer replay suite could not reach its workspace setup in this environment because the scaffold's workspace-directory dialog did not appear; its failure was unrelated to this change.
