# Agent Note: Remote event zero-delivery delegation

Status: implemented

English | [中文](2026-11-16-remote-event-zero-delivery-delegation.zh.md)

## Problem

Upstream rc.3 forwards `approval/request` and `user-questions/request` as waterfall Remote events: `startRemoteEvent` registers the pending invocation and delivers it to every answer-capable Client (`answers` principals). Settlement paths existed for results, rejections, full delegation (`deliveries.size === 0` after a result), cancellation, and source teardown — but not for a pending that had zero deliveries from the start. The invocation waited for a later Client generation indefinitely; the waterfall listener never reached `next()`, so every local listener behind it — including this fork's mux `question/requested`/`approval/requested` broadcast provider — starved. Unlike upstream, where the web client itself is a Remote-event Client, this fork's browser consumes the legacy mux downlink, so a Host with no attached Remote peers deadlocked every browser question and approval: the sidebar showed the wait while no composer could ever render and the turn never completed.

## Decision

- `startRemoteEvent` now settles `{ kind: 'next' }` when the initial delivery loop produced zero deliveries: a waterfall no answer-capable Client can see delegates to the next local listener at once. Remote peers attached at ask time keep first claim; late generations still receive pendings that retain at least one delivery.
- `removeRemoteEventClient` applies the same rule mid-flight: when a disconnect empties the last delivery, the pending delegates instead of waiting for a reconnect that may never come.

## Consequences

- A Host with no Remote peers answers questions and approvals through its local mux channel exactly as before rc.3; a Host with attached owner peers keeps remote-first claiming.
- Pendings created during a zero-peer window are no longer claimable by a generation that connects later — the trade a deadlock for ordering.
- Disconnected-then-local is a behavior change for multi-generation races and is covered by the updated host spec.

## Alternatives considered

- Registering the mux subscription as a Remote-event Client — rejected: it duplicates the answer UI contract across two wire protocols to recreate an ordering upstream already expresses as 'next'.
- Flipping waterfall registration order so the local provider runs first — rejected: Remote peers would never see any interaction even when attached, defeating the forwarding feature.

## Verification

- `gateway-remote-events.host.spec.ts`: the zero-delivery case now asserts immediate `{ kind: 'next' }` delegation; the late-generation case keeps redelivery coverage for pendings with live deliveries. 15/15 pass.
- Real browser e2e (`apps/web/tests/`): question-composer, approval-composer, timed-question-claim, live-interactions, steering, chat-long-interactions, documents-interaction-audit, permission-policy-context all pass against rebuilt `lib/` artifacts — the ask reaches the local provider, the composer renders, and the answer completes the turn.
