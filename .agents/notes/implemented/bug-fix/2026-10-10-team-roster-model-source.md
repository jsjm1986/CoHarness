# Agent Note: Team roster model reads the member's durable selection, not the spawn stamp

Status: implemented

English | [中文](2026-10-10-team-roster-model-source.zh.md)

## Problem

`TeamRoster.list` and `memberView` reported each member's model as `agent.options.model`. The host stamps `options.model` at every Agent create/resume from `ctx.agentDefaultModel.currentSelection()` — the deployment-wide default route — while a Web session's actual model travels the durable `model/selection` event and `request/header` configs through `ModelSelectionRef`. Any conversation whose user picked a non-default model showed the deployment default on every roster row (`模型: <default>`) regardless of what the member actually served, because the declared option never tracks the durable selection.

## Decision

The roster model now resolves through the same authority the conversation selector reads: `sessionProjections.stateOf(member.session, 'modelSelection')` yields `pending` (the latest `model/selection` not yet consumed by a matching request header) over `lastUsed` (the last request's route). The `modelSelection` key and its state type are registered and typed by the host API layer, so the roster reads the unit through a structural service shape rather than importing host types into an experimental package. Where the projection or the unit is not mounted — non-host compositions, minimal test contexts — the member's own `requestHeader()` fold supplies the last-used route, and `agent.options.model` remains the declared fallback for members that have logged neither. An inactive member without a live Agent keeps the previous `root.options.model` fallback because its session is not resident to read.

## Alternatives considered

**Keep `agent.options.model` and fix the stamping.** Rejected: `options` is immutable creation configuration; the live route is intentionally a separate mutable selection channel, so the field would still drift the first time a session selection differs from the default.

**Fold `session.events` directly inside the roster.** Rejected: synchronous raw event reads (`events`, `snapshotEvents`, `eventAt`) are deprecated for new callers; the session-projection registry is the sanctioned incremental fold and already computes exactly `pending ?? lastUsed`.

**Show only `requestHeader()`'s last-used route.** Rejected: a selection logged after the last request is the member's actual next-request route — exactly the case a user comparing the roster with the conversation's model selector notices.

## Consequences

`TeamMemberView.model` reports the model the member's next request would use: the Lead row follows the session's own model selection instead of the deployment default, and a live teammate row follows its own session's durable route. Members whose logs hold neither a selection nor a request header keep showing their declared creation model, and compositions without the host projection keep showing last-used-then-declared. No wire shape changes: the field is the same optional string, only its source corrected.

## Verification

`team.spec` gains a dedicated case that registers a structural `modelSelection` unit on the mounted projection registry, then covers the full resolution: declared model when the log is empty, last-used header when only requests exist, pending `model/selection` outranking an older header, an unrelated later header leaving the pending choice alive, the matching header consuming it so the newest used route wins, and a live teammate row reading its own session's selection. All 75 agent-team tests pass, including the pre-existing assertions that provisioning and non-live members omit the field.
