# Agent Note: Sustain write-behind admission failures through durability barriers

Status: implemented

English | [中文](2026-10-23-write-behind-admission-failure.zh.md)

## Problem

A live Session commits an event before notifying observers and contains observer exceptions. A bounded persistence observer can refuse that event without rejecting the append. A later flush of only the retained prefix cannot certify the complete live log.

## Decision

[`SessionWriteBehind`](../../../../packages/session/session-persistence/src/write-behind.ts) retains its first admission failure. It refuses further admission, drains already retained work, and rejects every subsequent flush with that failure. The controller remains non-empty for lifecycle ownership even after its retained prefix drains, so retirement and backend teardown cannot hide the missing sequence.

The [retention limits](2026-08-27-bounded-session-write-behind-retention.md) remain independent of recoverable backend write failures. Failed backend batches retain their data and can retry; an unretained live event cannot recover within the same controller by merely draining or increasing capacity elsewhere. SQLite and Gateway share this controller; JSONL's handle routing is independent.

## Alternatives considered

- **Clear the error after a successful prefix write.** Rejected: storage still lacks an accepted live event.
- **Retain rejected payloads outside the quota.** Rejected: it defeats the event and byte bounds during backend failure.
- **Add a core Session pre-commit persistence hook.** Deferred: it changes the synchronous Session publication API and every provider; fail-closed barriers preserve its current observer semantics.

## Consequences

A configured retention limit can stop progress until the affected lifecycle is replaced and deployment capacity is addressed. Explicit flush rejects; Cordis reports the teardown aggregate through its normal contained-disposal error channel. No Session event, format generation, or SDK transcript changes.

## Verification

The [SQLite regression](../../../../packages/session/session-persistence-sqlite/tests/retention-overflow.spec.ts) exercises count and byte overflow through real Session publication. It compares the retained stored prefix with the longer live log, requires repeated flush failures before and after another append, and checks the teardown error aggregate. Controller tests retain active-batch accounting and ordered backend retry coverage.
