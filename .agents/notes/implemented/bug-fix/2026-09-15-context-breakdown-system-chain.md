# Agent Note: Context breakdown keeps the effective system prompt and superseded nodes in separate figures

Status: implemented

English | [中文](2026-09-15-context-breakdown-system-chain.zh.md)

## Problem

The O(1) `contextBreakdown` fold priced `systemTokens` from the last `system/message` event's estimate and kept that event's surface delta out of the message figure. Two upstream properties were lost. When an in-history update appended a second system node, the superseded head's estimate vanished from all three figures instead of staying in the message figure as a still model-visible price; and an emptied-tail replace could zero the figure while an earlier nonempty node still held the effective prompt.

## Decision

The projection tracks live system nodes exactly in a small ordered list (`systems: {seq, tokens}`), updated from each system write's own price and the surface provenance rule — `sourceEventSeqs` covers every shadowed node, so any replace, whether prompt maintenance or a compaction, retires the entries it shadows. `systemTokens` is the newest surviving nonempty node's estimate; the message figure is the non-system surface fold plus the superseded entries' estimates, matching the upstream classification (effective prompt in system, every other surviving visible price in messages). A non-system replacement that shadows a tracked node conserves its estimate inside the message accumulator, keeping the fold's preserve-total contract consistent across buckets for both claim-priced and unclaimed replaces.

## Alternatives considered

**Deriving the system figure from the last event's estimate.** That is the regression being removed: it confuses event order with node survival.

**Repricing the whole surface per event like the retired per-node fold.** Rejected: the claim-based O(1) fold is the deliberate checkpoint design; only the system slice needed exact tracking, and it is bounded by live system nodes, not surface size.

## Consequences

`contextBreakdown` state moves to version 3 (`systems` replaces `systemTokens` in the checkpoint; the wire view is unchanged), so cold sessions re-fold once from their logs. The three figures now agree with the upstream composition rule in every sequence the projection accepts.

## Verification

`packages/llm/token-meter/tests/context-breakdown-projection.spec.ts` pins an in-history chain end to end — append, tail-emptying replace, and a metered compaction shadowing a live tail — plus the pre-existing single-head and checkpoint-shape cases.
