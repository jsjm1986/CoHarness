# Agent Note: Model policy refresh coalescing

Status: implemented

English | [中文](2026-10-23-model-policy-refresh-coalescing.zh.md)

## Problem

A background policy refresh can publish one subject before another subject finishes. Dropping a new refresh trigger while that pass is running leaves the earlier subject's file stale after its durable authorization changes. The runtime's [live policy watcher](../feature/2026-08-14-gateway-model-governance-live-policy-reload.md) cannot observe a file that was never refreshed.

## Decision

The worker retains one pending pass when another trigger arrives. Each pass reads current policies and retains its bounded retry sequence. It removes its active record inside its own finalization before the promise settles, so a trigger arriving at completion can start another worker instead of being discarded against a completed task.

## Alternatives considered

**Rely on the next browser request.** Lazy reconciliation may eventually refresh the file, but an already-running instance can continue making model requests without another browser request.

**Start a worker for every trigger.** Concurrent workers repeat full catalog and filesystem work; one pending pass retains the new state without an unbounded task queue.

## Consequences

An overlapping trigger can add one further pass. Successful database mutations remain successful while projection retries, and a worker's terminal record does not hide later refresh requests.

## Verification

A deterministic SQLite and filesystem regression holds a later subject, changes an earlier subject's model authorization, and requests another refresh. The earlier file must publish the denial after the held work finishes.
