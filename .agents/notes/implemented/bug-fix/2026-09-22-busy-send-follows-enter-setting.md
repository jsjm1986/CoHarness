# Agent Note: Busy Send follows the displayed Enter preference

Status: implemented

English | [中文](2026-09-22-busy-send-follows-enter-setting.zh.md)

## Problem

The busy-state preference selects Queue or Steer for Enter, but a pointer action fixed to Queue delivers the same draft differently. A generic Send label conceals that difference. Settings can also change while a draft stays mounted, so a label computed without subscribing to the preference can disagree with the next click.

## Decision

The composer and Settings row subscribe to the same account-owned `busyEnter` store. The composer resolves both Enter and the primary Send action from that value, the addressed Session's running state, and its steering capability. An enabled plain-message draft shows Queue message or Steer message while running; command drafts and unavailable inputs retain Send message. Disabled controls suppress their tooltip, including the transition from active Stop to disabled Send when a Turn settles.

The package-private keyboard face executes the resolved delivery. Other consumers of `InputActions.submit()` retain Queue semantics. Cmd/Ctrl+Enter retains the opposite mode and the empty-draft whole-queue gesture. Empty or owner-blocked ordinary Sessions retain Stop; continuable children keep their independent Stop, and parent-offline and one-shot restrictions still apply. The Host settings schema, account revision fence, authorization, and delivery-window behavior remain authoritative.

This partially supersedes the Queue-only pointer policy in [Running drafts take the primary Send action](2026-08-31-running-draft-primary-send.md). That note continues to own the primary-seat and owner-block rules. [Host-backed preferences](2026-08-06-host-backed-web-preferences.md) continues to own persistence and settings isolation.

## Verification

Component regressions cover both delivery preferences, live setting changes, commands, uploads, idle Sessions, child restrictions, and tooltip dismissal. The keyless [live interactions scenario](../../../../apps/web/tests/live-interactions.e2e.ts) parks a real composed Turn on a replay ready marker: Queue creates a removable Host queue row, while Steer produces a pending steering bubble and exactly one persisted next-step Inbox admission. Its running-draft snapshot records the mode-specific button name.

## Alternatives considered

**Keep pointer Send on Queue.** This leaves two visible ways to submit the same draft with conflicting behavior under one preference.

**Expose a delivery argument on the shared input action.** Only the composer needs this policy. Its existing private submission face accepts the mode without changing unrelated slot consumers.

**Read the preference only when clicked.** Delivery would update while the mounted button's label stayed stale. A shared subscription keeps both values current.

## Consequences

Users who select Steer receive Steer from Enter and the pointer button; Cmd/Ctrl+Enter provides Queue for one message. The primary button names that choice without adding another control or changing authorization. The default remains Queue.
