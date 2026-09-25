# Agent Note: Preserve execution identity in webhook-created Sessions

Status: implemented

English | [中文](2026-09-23-webhook-execution-identity.zh.md)

## Problem

An authenticated provider delivery proves who signed the payload, not which Gateway account may execute it. The upstream webhook runtime creates Sessions without account attribution. Treating signature verification as execution permission would bypass qualification checks and misattribute model usage.

## Decision

The [webhook runtime](../../../../packages/webhook/webhook/README.md) retains upstream rule registration, cancellation, Workspace attachment and prompt-source semantics. Managed Session creation stamps the input through the existing execution authority, then validates the requested permission preset before applying it or admitting the prompt. The authority provider must remain the same across asynchronous validation. Cancellation or denial detaches the Session and disposes its Agent; no prompt is admitted. Independent local deployments retain local operator authority.

The [GitHub adapter](../../../../packages/webhook/webhook-github/README.md) retains upstream raw-body bounds, signature verification and unavailable-secret behavior. Its process-local HTTP acceptance proves only dispatch. Shipped profiles do not mount a webhook endpoint. Gateway account binding, durable delivery deduplication, limits and administration require the Gateway intake owner; the raw adapter is not a substitute for those controls.

The Gateway delivery store reserves each endpoint/delivery identity in PostgreSQL before dispatch. A shared endpoint lock enforces the intake window across nodes; duplicate deliveries reuse their original receipt without consuming another slot. Changed content under the same delivery identity is rejected. Equal body digests with new delivery ids reuse the original receipt within the configured `replayWindowMs`, independently of the intake rate window. Durable delivery aliases preserve idempotency after that body window expires. Dispatching and unknown outcomes also block equal bodies outside the window. The store accepts no client-controlled replay bypass. Receipt identity survives configuration and signing-key changes. Only the reserving node can record admission, rejection or an unknown result; a conflicting completion fails. Unknown outcomes remain reserved and are never automatically redispatched. These storage guarantees do not replace endpoint authorization or prove Agent completion.

Managed intake can await a single registered rule through `invoke()` and receive the admitted Session id or `null` for no action. It uses the same creation and teardown path as broadcast dispatch, propagates failures and combines caller cancellation with registration disposal; it never waits for the model turn.

The Gateway intake owner is `gateway/src/webhook-intake.ts` over the `webhook_endpoints` table (migration 039). Each endpoint carries structured match rules, title and prompt templates, an execution account, a target runtime and an encrypted signing secret; endpoints are created disabled and an administrator enables one explicitly. The public provider route verifies the content type, bounded body, signature and delivery id before reserving the delivery, then checks the configured execution account and runtime liveness, holds one runtime operation reference through dispatch, renders the templates and issues a purpose-bound `webhook-dispatch` assertion. The managed runtime exposes a loopback-only dispatch route that validates the assertion, admits the bounded request and creates the Session through `createWebhookSession`; the Gateway completes the durable receipt as submitted, ignored, rejected or unknown, and releases the reference in `finally`. Administrator redispatch re-reads the endpoint inside the completion transaction so a deleted endpoint cannot be replayed.

Detached dispatch has no interactive principal, so the execution authority falls back to the current principal only when it carries `webhook-dispatch`, and the Gateway admits that purpose only on the execution input and selection paths; every other `/internal/runtime/*` endpoint still rejects purpose-bound assertions.

## Alternatives considered

**Use the signature as execution authorization.** A provider signature contains no Gateway user, project membership or Auto eligibility and cannot establish them.

**Give webhook work local operator privileges.** Missing managed identity must fail closed; a background trigger cannot gain more authority than its configured executing account.

**Replace the upstream runtime with a second Agent orchestration loop.** The existing creation and rollback path already owns the Session lifecycle. A narrow identity adaptation preserves that owner and its regression tests.

## Consequences

The generic runtime remains process-local and does not claim durable acceptance or Agent success. Managed callers must supply verified request context. Identity refusal, qualification refusal, cancellation and provider replacement are tested before prompt admission. The imported upstream HTTP and lifecycle suites remain active; Gateway end-to-end acceptance is separate evidence.
