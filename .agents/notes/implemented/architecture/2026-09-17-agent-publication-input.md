# Agent Note: Hold input during Agent publication

Status: implemented

English | [中文](2026-09-17-agent-publication-input.zh.md)

## Problem

Creation listeners can queue waking input before publication succeeds. Starting a turn at that point permits work from an Agent whose creation subsequently fails.

## Decision

AgentLoop runs setup and publication inside the existing maintenance operation. Successful completion releases queued wakes. Failed publication cancels the maintenance with `disposed` before the rollback handler disposes resources. Maintenance termination never replays wakes after a disposed cancellation, including when the inbox is retained.

## Alternatives considered

**Add a separate ready flag and queue.** Maintenance already owns input deferral and quiescence; a second mechanism would duplicate that ownership.

**Cancel only in the outer rollback handler.** Maintenance exits before that handler runs and can already replay a queued wake.

## Consequences

Creation is observable as maintenance activity. Listeners must not await the Agent's own idle state during initialization. Serial `agent/created` listeners are awaited and own startup initialization. Direct registry users must await registration before using an Agent.

Seven unit regressions cover successful publication, failed publication, retained input after disposed maintenance, repeated cancellation, root unload during replay, and ordinary cancellation with and without a subsequent wake. A driver that cannot enter its closing initiator scope returns to idle and settles its reserved completion without starting a turn. The headless product CLI snapshot pins publication rejection without a started turn; existing TypeScript SDK snapshots retain their expected output. Python packaged-runtime expected-output coverage remains unverified; the broader lifecycle migration is not release-ready.
