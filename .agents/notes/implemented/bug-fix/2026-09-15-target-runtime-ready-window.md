# Agent Note: Target-runtime readiness waits out transient reconnects

Status: implemented

English | [中文](2026-09-15-target-runtime-ready-window.zh.md)

## Problem

Opening a project conversation in the workbench picker needed two clicks. `SessionRuntimePool.runtimeForTarget` lazily starts a `forTarget` connection and awaits `entry.ready`; its `onStateChange` sink rejected that promise on the first `reconnecting` transition. `reconnecting` fires when one connection generation fails — before the controller's backoff retry runs — so a transient first handshake failure (the ordinary cold-start case for a project runtime) destroyed the pending entry and surfaced `target runtime connection unavailable`. The retry loop that would have established the target a second later was stopped by `releaseEntry`; the next click built a fresh entry against the now-warm target and succeeded.

## Decision

`entry.ready` now waits out reconnect transitions inside a bounded window instead of failing on the first one. A `TARGET_RUNTIME_READY_TIMEOUT_MS` deadline (30 s — two generation-handshake budgets) rejects the wait and releases the entry only when no generation has produced a ready session list in that span, so a permanently unreachable target still fails instead of hanging the picker. Settling `entry.ready` clears the deadline through the promise chain, and `releaseEntry` continues to reject the wait for releases that are not connection-driven. Reconnect bookkeeping — `WorkspaceResourceRegistry.disconnect` and `SessionRuntime.handleDisconnected` — still runs on every `reconnecting`, unchanged for established entries; on a pending entry both are no-ops or empty-state resets that the next `onConnected` refresh overwrites.

## Alternatives considered

**Retry `ensureSession`/`chooseSession` at the operation layer.** Rejected: each attempt rebuilds the connection and fiber from scratch, discarding the retry progress the existing loop already makes, and it leaves the same race inside every other `runtimeForTarget` caller.

**Count generation failures and reject after N.** Rejected: `onFailure` reports are not one-per-generation (a handshake error and stream errors can both report for one generation), and `reconnecting` is deduplicated across the whole retry span, so neither sink yields a clean generation counter.

## Consequences

A first selection that hits a transient target outage now waits through the retry and adds the pane on one click; a dead target surfaces `target runtime connection unavailable` after the window instead of immediately. The picker's `pending` flag stays raised for the whole wait, so the deadline is also the dialog's unlock bound.

## Verification

`session-pool.client.spec.ts` drives a `reconnecting` emission followed by `onConnected` through the fake `ConnectionHandle` and asserts `ensureSession` resolves on the same entry, and a fake-timer case asserts the deadline rejects and releases the entry.
