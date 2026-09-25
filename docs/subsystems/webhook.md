# Webhook runtime

English | [中文](webhook.zh.md)

The Webhook subsystem turns authenticated external deliveries into optional ordinary root Sessions. Provider adapters own authentication and generic JSON intake; trusted programmatic rules own conditions and external calls; `ctx.webhookRuntime` owns callback lifetime plus Workspace-backed Session creation. The [execution identity decision](../../.agents/notes/implemented/architecture/2026-09-23-webhook-execution-identity.md) separates this process-local runtime from managed Gateway intake.

## Shared values

`WebhookRuleId`, `WebhookSourceId`, and `WebhookDeliveryId` are opaque strings. A delivery id records the provider's identifier only: the runtime neither stores nor deduplicates it.

`WebhookEventMap` is merge-extensible by provider kind. `WebhookEventOf<K>` selects a known provider event and otherwise admits generic lossless JSON, allowing an out-of-tree adapter without changing the runtime package.

`VerifiedWebhookDelivery<K>` contains `kind`, configured `source`, provider `deliveryId`, normalized `event`, and non-negative safe-integer `receivedAt`. The runtime validates, detaches, and freezes the entire value before dispatching it to more than one rule.

`WebhookRule<K>` contains a unique id, provider kind, and `run(delivery, signal)`. The callback may execute arbitrary trusted code. It returns `null` or one `WebhookSessionRequest`, and it must observe the signal for asynchronous work that should stop when the registration unloads.

`WebhookSessionRequest` requires an absolute `workspacePath`, title, text prompt, agent preset, and permission preset. Optional `model` names an explicit provider/model route plus optional output-token cap and uses that adapter's reasoning default. Omission snapshots the complete current deployment selection, including reasoning effort, until the first request records its durable header.

## Fire-and-forget dispatch

`dispatch()` snapshots the matching rules, schedules each independently, and returns before any callback settles. Throws and rejections are contained per rule. Registration disposal removes the rule before aborting and draining its active calls, so no later delivery can enter code that is unloading.

The runtime has no queue, retry, deduplication, execution status, crash replay, Agent-status listener, or completion result. Repeated delivery may create repeated Sessions. The only active-operation table is private teardown bookkeeping and disappears with the process.

`invoke(ruleId, delivery, signal?)` awaits one registered rule and returns its admitted Session id or `null` for no action. It propagates failure and combines caller cancellation with registration disposal. The return value proves prompt admission, not completion of the Agent turn.

## Session creation

A non-null result is snapshotted before asynchronous preflight. The runtime validates permission and agent presets, resolves or creates the canonical Workspace, creates an Agent whose Session cwd equals the Workspace path, mounts the selected agent preset before publication, and durably attaches the Session before applying permission, title, and the initial follow-up.

In a managed deployment, Session creation stamps the input through the current execution authority and authorizes the selected permission preset before applying it or admitting the prompt. Missing identity, revoked qualification, authority replacement, and cancellation reject admission and trigger rollback. An independent local deployment retains local operator authority.

The follow-up is a normal durable user-role message with `source.kind: "webhook"` and the provider, source, delivery, and rule identifiers. Its accepted inbox insertion commits the webhook operation. The runtime does not specially flush or wait for the turn; ordinary Session persistence and Agent lifecycle apply afterward.

Failed attachment disposes the new Agent before a prompt exists. A failure between attachment and prompt admission attempts Workspace detach and Agent disposal without replacing the original error. A Workspace automatically created during preflight remains because another concurrent caller may already use it.

## GitHub adapter

`@deepseek-ai/dsh-webhook-github` registers an exact route on an injected WebServer, resolves its credential reference for each request, verifies the untouched `application/json` body before parsing, and returns `202` immediately after in-memory dispatch. Its normalized event guarantees a signed lossless-JSON object; rules validate the event-specific fields they consume.

An independent deployment can mount this route on an isolated second WebServer so exposing webhook ingress does not expose the browser API. The shipped profiles do not enable an endpoint. Gateway endpoint management, durable cross-node deduplication and execution-account binding are not supplied by this adapter.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwebhookruntime--webhookruntime"></a>

### `ctx.webhookRuntime` — `WebhookRuntime`

Fire-and-forget rule runtime. Session creation is the only built-in action.

```ts cordis-catalog
/**
 * Register one trusted programmatic rule.
 * @param rule - unique id, provider kind, and arbitrary callback.
 * @returns awaitable effect disposer that aborts and drains this rule's active callbacks.
 */
register<K extends string>(rule: WebhookRule<K>): () => Promise<void>

/**
 * Start every currently matching rule and return before any callback settles.
 * @param delivery - authenticated provider data; snapshotted before dispatch.
 * @throws synchronously when the runtime is closing or the delivery is malformed.
 */
dispatch<K extends string>(delivery: VerifiedWebhookDelivery<K>): void

/**
 * Await one explicitly selected rule through prompt admission without waiting for the Agent turn.
 * @param ruleId - registered rule selected by trusted intake configuration.
 * @param delivery - authenticated provider data, detached and frozen before the callback.
 * @param signal - optional intake cancellation, combined with registration disposal.
 * @returns the admitted Session id, or null when the rule chooses no action; failures reject.
 */
async invoke(ruleId: WebhookRuleId, delivery: VerifiedWebhookDelivery, signal?: AbortSignal): Promise<SessionId | null>
```

Types: [SessionId](core.md)

Source: [`packages/webhook/webhook/src/index.ts`](../../packages/webhook/webhook/src/index.ts)
<!-- END GENERATED cordis-surface -->
