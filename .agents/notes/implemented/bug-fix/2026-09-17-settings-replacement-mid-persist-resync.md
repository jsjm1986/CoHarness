# Agent Note: Mid-persist namespace replacement re-resolves under the new owner

Status: implemented

English | [中文](2026-09-17-settings-replacement-mid-persist-resync.zh.md)

## Problem

A serialized settings write resolved its value and persisted the raw section under the registration captured at call time. If that fiber was disposed and replaced while `persist` was in flight, the queue runner still wrote `document[ns]` — correct, since storage committed — but never re-resolved the section for the replacement registration. The replacement kept the value it computed at its own registration, so its resolved state and its watchers' last emission went stale relative to what was now on disk.

## Decision

After `persist` returns, the queue runner commits through whoever owns the namespace at that moment: the same registration reuses the value already resolved for the write; a replacement registration re-resolves the persisted section under its own schema/base/validate and is then bumped and committed like any other update. A section the replacement's schema rejects keeps that registration's last good value and warns, mirroring `publish`. A disposed-not-replaced namespace updates the document and notifies nobody.

## Alternatives considered

**Guard the `document[ns]` write by ownership.** Rejected: the document cache must mirror what storage holds; skipping it would leave the cache stale against the committed write.

**Reject the write when the owner changed.** Rejected: the write already reached storage — rejecting after commit reports a failure for an outcome that succeeded, and the queue's earlier ownership check already covers writes that never ran.

## Consequences

A replacement registration observes every write that reached its namespace, including one queued by its predecessor; watchers see the persisted section resolved under the schema they actually registered. The writer's promise still resolves — the write succeeded — even when the replacement's schema rejects the section for display.

## Verification

`settings.spec.ts` replaces the namespace owner during a delayed persist and asserts the replacement resolves the persisted section under its own schema defaults and emits `settings/updated` with `source: 'update'`.
