# Agent Note: Durable memory mutation outcomes

Status: implemented

English | [中文](2026-10-23-memory-mutation-outcomes.zh.md)

## Problem

Entry persistence and consolidation counters occupy separate records. A cursor failure after entry persistence rejects a successful mutation, and a throwing change observer can do the same. Retrying then encounters changed data despite the reported failure.

## Decision

Persist the conservative consolidation marker before the authoritative entry mutation. A marker failure leaves the entry unchanged. An entry failure can leave an extra marker, which the content-digest check handles without treating unchanged content as new work. Notify observers after entry commit and contain synchronous observer failures with a warning.

## Alternatives considered

**Roll back a committed entry.** A compensating write can fail and can replace a committed revision with an uncertain outcome. Keeping the authoritative mutation last avoids that second transaction.

**Ignore failed cursor writes.** A committed entry can then lack the durable counter required to trigger consolidation after a restart.

## Consequences

The counter is an upper bound on admitted changes, not a multi-record transaction. This trades an unnecessary digest check after a failed entry write for reliable admission of every committed change. Change notifications remain post-commit observations; their diagnostics cannot undo persistence.

## Verification

Create, update, and delete regressions inject cursor failures and observer exceptions independently. Cursor failures retain the original data and emit no change; observer exceptions preserve successful mutation results and committed state.

The keyless headless snapshot runs a real `memory_delete` tool turn against JSON storage with a throwing observer, preserving the successful tool result and the durable deletion.
