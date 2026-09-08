# Agent Note: Agent-free Inbox projection

Status: implemented

English | [中文](2026-09-08-cold-inbox-projection.zh.md)

## Problem

An Agent-free Session history read has durable inbox splices but no live Agent from which to obtain the pending queue. A tail page may omit earlier splices, so the browser cannot rebuild the pending input from that page alone.

## Decision

ApiProxy registers an `inbox` Session projection through a disposable Cordis effect. It ignores inherited events, folds both inbox targets, rejects invalid splice ranges and duplicate identities, and publishes the pending rows through the existing projection carrier. Client Session instances subscribe to their own projection store and release that subscription on disposal. Live queue mutation and its admission limits remain owned by Agent.inbox; history reads do not activate Agents or authorize mutations.

## Alternatives considered

Restoring a live Agent for a history read would introduce execution and lifecycle effects into a read operation. Replacing ApiProxy with upstream controllers would also replace CoHarness authorization and multi-runtime routing without being necessary for this projection.

## Consequences

Cold history can display pending input while preserving Gateway authorization and each pane's runtime owner. The existing live queue frames remain compatible with clients that lack the projection. Their duplicate payload cost needs measurement before removing either delivery path. The [claimed inbox lifecycle](2026-07-31-claimed-pre-step-inbox-lifecycle.md) remains authoritative for mutation and claim behavior.
