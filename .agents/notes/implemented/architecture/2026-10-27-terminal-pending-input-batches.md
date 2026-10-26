# Agent Note: Ordered pending input batches for browser terminals

Status: implemented

English | [中文](2026-10-27-terminal-pending-input-batches.zh.md)

## Problem

The browser emulator can emit one input callback per key. Awaiting an independent Remote request for each callback makes a command entered during an outstanding write accumulate network round trips, even though its pending bytes belong to the same terminal and attachment.

## Decision

The [terminal Client model](../../../../packages/api/terminal-controller/README.md) keeps adjacent pending input in one instance-owned batch within its existing ordered write queue. The first request starts without a delay timer. Input arriving before a pending request starts appends to that batch; a request already in flight is immutable. Resize ends the pending batch so input cannot cross the resize operation.

The existing UTF-8 byte budget includes both in-flight and queued input. Each batch releases its complete byte count when its queued operation settles, including discarded work. No additional request size, concurrency setting, timer or global queue is introduced.

Every batch captures its terminal and attachment identities. Detachment separates subsequent input, and the queued operation rechecks current attachment ownership and writable state before sending. Input refused after control transfer is not replayed. Late failures cannot disable a replacement attachment. The [Web terminal decision](../feature/2026-09-09-web-sidebar-terminal.md) retains stream, process and explicit-close ownership; [private user terminals](2026-09-23-private-user-terminals.md) retains creator isolation and authorization. Neither note is superseded.

## Alternatives considered

**Send concurrent input requests.** HTTP completion order cannot establish PTY input order or preserve resize positions.

**Wait for a batching timer before sending the first key.** Pending work already provides the accumulation point; a timer adds latency and another scheduling choice.

**Carry queued input into a replacement attachment.** The replacement may represent a different control grant. Dropped input must remain dropped rather than execute after control changes.

## Verification

The model cases hold the first reply and check exact remaining input, request counts, resize positions, UTF-8 budget release and stale-attachment behavior. Their assertions use controlled replies and operation order rather than elapsed-time limits. The assembled Web terminal case types through the real browser and Host into an explicitly configured portable shell, checks the resulting file contents and request count, then exercises reload retention and explicit cleanup without a model turn.

## Consequences

The change reduces requests when input arrives faster than replies. It does not guarantee a fixed number of requests for every typing cadence or remove output-rendering and network delays. Read-only transitions still follow attachment ownership; input aggregation does not relax or repair that policy.
