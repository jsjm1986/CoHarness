# Agent Note: Claim inbox input before one pre-step decision

Status: implemented

English | [中文](2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md)

## Problem

The loop previously split one step boundary across prompt preparation, prompt admission, and a serial step hook. Claimed input could be retained or discarded by an admission result, and live queue events carried shapes that duplicated durable inbox state. Plugins had to choose whether to mutate the inbox, rewrite a submitted batch, or append directly to session history, while observers could not rely on one exact ordering.

Occurrence-local inbox wrappers also duplicated the identity already carried by every `UserMessage`. They made insertion, editing, claiming, cancellation, reconnect projection, and step entry one combined protocol even though the append-only session already owned the durable queue projection.

## Decision

Before every proposed step, the loop's package-internal `ReactLoopInbox` atomically claims the complete batch: all `next-step` messages and, at a turn boundary, one `next-turn` message. At the initial boundary the loop first commits `turn/start`, so the claim and its single `agent/pre-step` decision have durable turn ownership. Claiming records normalized `agent/inbox/spliced` pure deletions with no outcome, emits `agent/inbox/claimed { message, turn }` once per claimed message, and returns the exclusive batch for the loop's waterfall with `{ turn, step, signal }`.

`PreStepDecision` is `{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }`. Reject opens no step, leaves the claimed batch removed, and closes the turn as blocked without any step events. Empty entry, cancellation, and failure before `step/start` likewise close a balanced no-step turn. Enter supplies the complete batch appended as `user/message` events after `step/start`. A listener wrapping `next()` preserves downstream changes unless it intentionally replaces them, so all message rewrites settle once in the final return value. There is no `agent/prompt-prepare`, `agent/prompt-submit`, or `agent/step` extension point.

The durable inbox remains two `UserMessage[]` lists addressed by `MessageId`. `append`, `prepend`, and `splice` take a target, while `replace(messageId, newMessage)` and `remove(messageId)` locate the pending message across both lists before committing a normalized splice. Replacement may change identity and emits the old message as discarded followed by the new message as inserted. Every insertion emits `agent/inbox/inserted { message }`; an ordinary removal records `outcome: 'canceled'` and emits `agent/inbox/discarded { message }`. Claiming records pure deletions without an outcome and emits claimed events from `ReactLoopInbox`. These live events add no placement, outcome, or batch fields.

`Agent.inbox` exposes structural commands for reading and mutating pending work. `ReactLoopInbox` also owns the driver's `hasPending` and claim operations. It applies `InboxLimits` before each durable commit. It measures incoming messages and reuses UTF-8 JSON byte counts by object identity for immutable projected messages that remain pending. `AgentLoop` owns the `inbox` projection registration, so cold reads work before any Agent exists and after all Agents unload.

`hasPendingUserSteer` reads the live wake bookkeeping for user-authored messages that are still in the next-step inbox. In-place edits retain the delivery intent. The job-output wait releases on that signal and leaves the producer running. Injected context and ordinary queued turns retain their delivery semantics.

Observers following one message use `agent/inbox/inserted`, `claimed`, and `discarded`. Each `ReactLoopInbox` reads the `inbox` projection folded over the durable `agent/inbox/spliced` stream. UI edits and removals route through an Inbox mutation method. The fold rejects invalid coordinates and duplicate `MessageId` values across both lists and reports the offending sequence. ApiProxy also projects the Session's own items into `queuedInbox` for Agent-free history reads.

Plugins that need current-step atomic rewriting return messages from `agent/pre-step`. Plugins that only need later context may mutate `agent.inbox` directly. Workspace context uses both paths: asynchronous filesystem projections stage one replaceable `next-step` item, while the next entering pre-step folds that item or a newly composed baseline into its final batch and removes the pending copy. Rejection keeps the item queued.

The archived [addressable queue occurrence decision](../../archived/feature/2026-07-29-addressable-queue-operations.md) describes the superseded occurrence-wrapper design. `MessageId` owns addressability.

## Alternatives considered

**Keep separate prepare and admit hooks.** This lets preparation mutate the inbox before claiming and admission rewrite afterward, but it creates two ordering surfaces for one boundary and makes cancellation ownership ambiguous.

**Let rejection requeue the claimed batch.** This preserves retry-like behavior but turns a veto into hidden queue mutation, duplicates later work unless every race is fenced, and prevents claim from being an atomic ownership transfer.

**Put placement and outcome on every live event.** Durable splices already own those facts. Repeating them on live notifications creates a second contract that can drift and is unnecessary for consumers holding the exact message identity.

## Verification

Agent-loop coverage pins turn-start-before-claim-before-pre-step ordering, exact live event payloads, balanced no-step rejection, final-batch rewriting, input inserted after a claim, listener failure, cancellation, agent-scope projection removal after the last owner unloads, and the `InboxLimits` admission quotas. Inbox and consumer tests pin pure claim deletions, canceled ordinary removals, agent-instructions staging, replacement, and same-step entry, plan/goal/hook behavior, UI cleanup, compaction, checkpointing, resumed durable projection, and rejection of invalid persisted coordinates or cross-list identities. Consumer-domain tests use a detached session-backed `ReactLoopInbox` or a process-local Inbox stub only when durability is outside the test subject; claiming, durable projection, recovery, validation, and live-notification tests create Agents through the production AgentLoop test harness, so test support never reimplements the projection. Generated event and type catalogs expose only the new waterfall and payloads.

## Consequences

The loop has one awaited decision before each step and one ownership transfer for its input. Claimed messages never return to the inbox implicitly; later insertions remain independent. Live events are symmetrical with other inbox notifications without mirroring durable metadata, and plugins can choose exact-current-step rewriting or ordinary later inbox delivery explicitly.
