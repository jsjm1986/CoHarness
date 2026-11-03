# Agent Note: SDK notification lifetime and active ancestry

Status: implemented

English | [中文](2026-10-24-sdk-notification-lifetime.zh.md)

## Problem

Notification filters can close subscriptions, including themselves or later subscribers in the same dispatch. A dispatch snapshot does not prove that a subscription still accepts new frames after its filter returns. Active ancestry also outlives an individual queued notification: tying ancestry capacity to queue capacity can silently remove an ancestor while all queues remain drained.

## Decision

Both SDKs recheck subscription ownership after calling a filter. Python also checks membership before calling each snapshot subscriber and holds its client lock for the final membership check and queue insertion. Filters run outside that lock so they can close subscriptions.

Active parent-child relationships have their own positive integer capacity, defaulting to 10000. A finished child releases its relationship. A new edge exceeding capacity fails existing and future notification subscriptions with `TransportClosedError`, clears incomplete ancestry and prevents restarting that client. The caller closes it and creates a new client with adequate capacity.

## Alternatives considered

**Evict the oldest active edge.** Descendant notifications then disappear from a session-tree subscription without a queue overflow or a reported error.

**Run filters while holding the client lock.** A filter closing its subscription needs the same lock and can deadlock.

**Check membership only before a filter.** The filter can close its own subscription before returning a matching result.

## Consequences

Queue capacity bounds pending frames per consumer; ancestry capacity bounds simultaneously active parent-child edges. Neither silently weakens the other. A relationship-limit failure terminates delivery explicitly, so callers cannot mistake a partial tree for complete task output. These changes add SDK configuration without changing the runtime wire or Session events.

## Verification

TypeScript and Python regressions exercise self-closing filters, sibling removal and independent ancestry capacity. A runnable SDK composition delegates through the real tool to a child and grandchild. A continuously drained one-frame queue must retain all three assistant outputs. Startup tests also exercise failed process spawning without unrelated event-loop handles.

An owned runtime subprocess emits scripted notification batches before its working-directory response. These wire barriers cover self-closing filters, drained one-frame ancestry, overflow isolation and two batches of 160 frames under a queue limit of 200; they do not invoke private dispatch or subscription producers. Relationship overflow is exercised through the running transport and rejects future subscriptions and restart.
