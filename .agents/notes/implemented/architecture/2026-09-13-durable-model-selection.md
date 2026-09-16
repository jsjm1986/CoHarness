# Agent Note: Durable model selection for the next request

Status: implemented

English | [中文](2026-09-13-durable-model-selection.zh.md)

## Problem

The Web model selector kept the session's choice only in process memory. When a Session went cold between the selection and the request that would consume it, resume rebuilt the selection from the folded `request/header` — the previous route — or from the deployment default, silently dropping a selection the user had already made. The earlier [catalog and selection decision](2026-07-15-llm-model-catalog-and-acp-selection.md) kept selections in-memory under the model-visible-iff-logged rule, but a pending selection is not ephemeral UI state: it determines which route the next request uses, so it is part of request reconstruction.

## Decision

`model/selection` is a `SessionEventMap` member declared by the API proxy package. Its payload is the complete validated `ModelSelection` — provider, model, and optional adapter-owned reasoning effort — appended by the proxy's `selectForNextRequest` when `session.selectModel` accepts a switch. The event is log-only: it carries no `surfaceOp`, produces no derived message, and does not materialize a draft Session. It is required-on-read rather than `ignorable` because a reader that dropped it would reconstruct the next request's route incorrectly.

The `modelSelection` projection folds the pair clients need: `lastUsed`, the selection consumed by the latest recorded `request/header`, and `pending`, a later selection not yet consumed. Its wire view publishes `{ lastUsed, next }`, where `next` falls back to `lastUsed`.

The proxy's session-local selection resolves on every read in the same order as before, with one new tier: a selection recorded in this process or restored from `pending`, else the latest logged `request/header`, else the live Agent default. A committed `request/header` whose provider, model, and effort all match retires the pending value through the `session/event` feed, so the durable intent and the execution cache share one consumption point. An adapter-defaulted effort in a restored header is not read back as an explicit selection, preserving the distinction between caller choice and adapter resolution.

Deployments without the projection registry keep the durable record but restore through the header/default fallback, matching the proxy's optional-registry posture for its other units. Project-scope authorization is unchanged: the durable event records the session-local selection, while the deployment-default save remains personal-scope only.

## Alternatives considered

**Keep selections in memory until a request uses them.** This was the prior stance. It made cold resume lose a selection the user had already committed, and it gave the models RPC no way to report a pending choice on a reactivated Session.

**Mark the event `ignorable`.** Skipping it silently is a wrong read, not a lossless one — the pending route is exactly what the next request must use.

**Derive pending from the last `request/header`.** That is the `lastUsed` tier, not intent: a selection logged before its request exists has no header to read.

## Consequences

- A cold Session restores the selection its user last committed, across process restarts and registry recomposition.
- Every `model/selection` event is readable by any in-repo build because the type enters `KNOWN_SESSION_EVENT_TYPES`; out-of-repo readers face the same required-on-read refusal as any unknown required type.
- The pending tier wins over the latest header until a matching header commits, so a selection made during an in-flight request does not leak into that request's route retroactively.
- Client carriers receive the `{ lastUsed, next }` view through history baselines and `session/projection` frames with no per-domain client code.

## Verification

`packages/host/apiproxy/tests/api-proxy-models.spec.ts` covers durable logging on `selectModel`, pending restore over a logged header, retirement by a matching header, preservation across a non-matching header, and the adapter-defaulted-effort guard. `packages/client/connection/src/client/fixture.ts` mirrors the fold for replay fixtures, including the baseline and per-event `session/projection` frames.
