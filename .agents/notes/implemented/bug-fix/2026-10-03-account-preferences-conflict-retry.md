# Agent Note: Retry account-preference writes on a stale revision fence

Status: implemented

English | [中文](2026-10-03-account-preferences-conflict-retry.zh.md)

## Problem

The Settings rows backed by account preferences (transcript detail, busy-Enter behavior, display width/size, performance detail) intermittently showed "设置未能保存，请重试。" even though the write could succeed on retry. Four rows share one `conversationSettings` scope, so a single failed PATCH painted an identical error under every row.

## Decision

**Treat `account-preferences-conflict` as a fence to re-read, not a failure to surface.** `AccountSettingsScopeController.write` extracts the mutate+accept step into an `attempt` closure; on a conflict it clears the retained response fence, reloads the mirror (the recovery read already runs on every failure), and retries exactly once on the fresh revision. Any second rejection — conflict or otherwise — reports through the same `failWrite` path as before. The retry rides the existing serialized write queue, so it cannot reorder against queued successors.

## Alternatives considered

- **Silent recovery without retry.** Already the behavior: `mirror.load()` refreshed the revision, but the red notice stayed visible until the user changed the value again — the visible complaint.
- **Drop `expectedRevision` from writes.** Rejected: the fence is the only guard against two tabs silently clobbering each other; retrying once keeps the guarantee while making single races invisible.

## Consequences

A write that loses a revision race against another tab or a queued sibling now lands on the fresh revision instead of erroring; genuine transport and validation failures still surface unchanged. The shared-scope amplification (one failure → every row red) remains a presentation property: with transient conflicts resolved silently, the remaining red text means a real failure.
