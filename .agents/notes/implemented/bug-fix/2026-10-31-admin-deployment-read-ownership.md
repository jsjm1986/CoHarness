# Agent Note: Admin deployment read ownership

Status: implemented

English | [中文](2026-10-31-admin-deployment-read-ownership.zh.md)

## Problem

Deployment polling can outpace a slow computer and retain requests after its page closes. A manual refresh after a mutation also needs a newer read than an already pending snapshot. Localizing a diagnostic before matching its code loses operation-specific recovery guidance.

## Decision

Each deployment page waits for initial entry policy before loading cluster and backup snapshots, then owns one read and its cancellation signal. Periodic ticks admit no overlapping or queued work. Explicit refreshes coalesce into one successor after the current read settles; unmount aborts the transport and discards late results.

Entry metadata uses the shared account read API before Runtime forwarding. Administrator checks remain on configuration mutations. Typed Admin failures keep the Gateway code separately from localized display text; operation handling uses the code.

## Alternatives considered

**Poll on every interval.** Slow responses multiply in-flight authentication and database work.

**Return the pending snapshot for every refresh.** A read started before a mutation cannot establish its resulting state.

**Match translated text.** Locale changes and specialized display copy cannot preserve a stable failure discriminator.

## Consequences

Slow reads retain existing information while bounding each document's request load. Explicit post-mutation refreshes can observe committed state without synchronizing another tab's form or target. The [deployment reference](../../../../gateway/docs/deployment-topology/README.md) owns entry scope and configuration behavior.
