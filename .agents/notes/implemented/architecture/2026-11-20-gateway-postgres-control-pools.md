# Agent Note: Gateway reserves PostgreSQL capacity for control traffic

Status: implemented

English | [中文](2026-11-20-gateway-postgres-control-pools.zh.md)

## Problem

An access listener retained one permanent business checkout. A single-connection business pool therefore lost all foreground capacity. Larger business pools could delay fresh readiness checks, writer heartbeats and exact lease renewal behind unrelated work. A blocked Runtime stop also delayed observation of later revocations.

## Decision

The Gateway has a bounded business pool, an independent single-connection access listener, and a separately configurable control pool. The access listener reads the committed outbox and acknowledges applied revisions after their cleanup. If another committed revision arrives during a pending application, a bounded revision read detects the backlog and immediately fences admitted traffic while the ordered application catches up.

Readiness verifies the listener's observation and cancellation dispatch independently of cleanup acknowledgment. A single subsequent control-pool query verifies active organization and node eligibility in the same database snapshot as the startup write epoch. The shared snapshot avoids a separate network round trip on remote Gateways and detects a restore committed during listener observation. Runtime admission and renewal require the ordered application to settle. The writer heartbeat retains the observed maintenance epoch and its in-flight writer count. Node renewal checks the current serving write epoch through the statement that renews the exact connection lease. Ordinary business write admission and administrator operations keep their business connection source.

The two Runtime stream control routes require the exact current bearer and generation through the reserved pool. Event renewal also qualifies the original browser session, computer and any project scope. Outbox synchronization before and after qualification and the registered socket identity continue to determine publication. Ordinary Runtime and browser requests retain business admission. Startup failure closes the registered listener consumers and pools. Normal shutdown drains consumers before releasing the pools.

## Alternatives considered

**Raise the business pool limit.** The permanent listener still holds one checkout, and a busy business queue can consume all remaining capacity regardless of its size.

**Share a control pool with the permanent listener.** A control pool with one connection would again lose its capacity. The dedicated listener also remains independent of transient control checkouts.

## Consequences

An operator can configure one business connection. The default connection budget for each Gateway includes one listener and up to two additional control connections. Query locks and database outages can still refuse control work. A ready Gateway can have pending Runtime stops, so consumers that require settled cleanup use the durable access revision. The additional pool counters are visible through the existing administrator performance endpoint.

## Verification

The focused listener fixture holds cleanup of one revision and verifies cancellation after a later commit is observed without business checkout. The renewal fixture verifies that a Runtime with the same owner and generation cannot renew another allocation's socket. The Gateway saturation fixture holds the business pool and verifies that readiness uses one control-pool query after cancellation, while the Runtime stop remains unacknowledged. It also checks node renewal and the durable acknowledgment after business capacity returns. The PostgreSQL readiness check refuses an advanced write epoch or a draining computer.
