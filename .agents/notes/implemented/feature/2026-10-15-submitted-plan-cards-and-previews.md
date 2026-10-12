# Agent Note: Submitted-plan cards and Session-backed sidebar previews

Status: implemented

English | [中文](2026-10-15-submitted-plan-cards-and-previews.zh.md)

## Problem

`ui-plan` shipped only the composer chip: once `exit_plan_mode` settled, nothing in the conversation kept the submitted plan reachable, and an uncommitted plan review had no durable route to the document its buttons summarize. The user could approve, refuse, or dismiss a review and then never see the plan text again. Upstream solves this with a turn-scoped `turnDataSource`, a `dsh-client-resources` streaming provider, and `remote.session.follow`/`page` history reads — abstractions this codebase does not have, so the gap needed a semantic port, not a mechanical transplant.

## Decision

A submitted plan is one hidden `submitted-plan` Chat node keyed by the exit-tool invocation — the native `tool/call` id, or the `subCallId` of a `tool/ptc-dispatch-start`/`tool/ptc-dispatch` pair. The `submittedPlanDefinition` Conversation definition emits these nodes on both event families; hidden nodes never enter `order` or `locations`, but `chat.nodes.values()` retains them, so `conversation.chat.turnTail` cards scan the node store filtered by turn instead of needing a turn data source — the same store already keeps the events, so nothing else has to persist them.

A card opens `dsh-resource://plan/<session>/<callId>`, or `dsh-resource://plan/subagent/<parent>/<child>/<mode>/<callId>` for a direct-child subagent, into the visible Session's sidebar through `openSessionResource`. The `plan` Sidebar tab type claims those addresses plus transient `dsh-resource://plan-review/<session>/<key>` addresses, which carry the uncommitted review's Markdown in navigation params rather than durable storage — a review that never logs cannot be recovered from history, so its content travels with the tab. `resourceSession` parses the owner out of the address (the child id for a subagent address) so the sidebar ownership validator accepts a subagent plan opened from its parent's screen.

Durable documents load through `Session.readCallHistory`, which retains the owner named in the address — subagent addresses route to the child session — and reassembles the call's complete turn through the same conversation definitions, recovering the `submitted-plan` node from the authoritative log. This replaces upstream's `remote.session.follow` paging with the targeted server-side `toolCallId` lookup plus one shared generation.

`conversation.plan-review.actions` gains a `PlanReviewOpen` entry: it opens the review once automatically when a Session is mounted, reading `sidebarRight.mounted` at call time rather than at render so a seat that changes between commit and effect cannot strand the open; the opener reports whether an open reached a seat and the review is marked opened only after one does, so the effect retries when the mounted Session changes while a dismissed review stays closed. `sidebar.right.pane.tab` and its title seat render the recovered document and heading through `MarkdownText`; the plan-read store publishes loading, ready, and localized failure states per address, resets on `connection/reset`, and keeps reads keyed by address so a stale publish cannot mislabel a tab.

## Alternatives considered

**Add a turn-scoped query API to the conversation engine.** The engine already materializes hidden nodes, and filtering `nodes.values()` by location covers the same reads without a second storage path — worth revisiting only if node scans show measurable cost.

**Encode the review document in the resource address.** Address strings are persisted in sidebar layout; uncommitted Markdown has no business surviving a reload, so params carry it and a restored review-preview shows the localized expired state.

**Skip the `resourceSession` owner on the tab type.** Upstream leaves it unset, but the local sidebar validator requires every resource to resolve to the Session opening it; reading the owner from the address preserves that invariant while keeping a child plan openable from its parent's screen.

## Consequences

Every submitted plan survives its review outcome in the completed turn's artifact area, reopens as a focused tab, and restores after a browser reload. A child subagent's plan lands in the visible parent's sidebar but reads the child's own log. Plan review open attempts that cannot reach a seat remain pending instead of being recorded as shown.

## Verification

`plan.client.spec.ts` — native and PTC plan extraction, address round-trips, hidden-node assembly across turns, per-invocation identity, and dropped non-plan invocations. `plan-resource.client.spec.ts` — session and subagent retention, invalid-address and unavailable failures, read failures, call-id mismatch, and publish suppression after `connection/reset`. `plan-preview.client.spec.tsx` — turn-tail cards, automatic and manual review opens, seat-retry and dismissal semantics, Markdown rendering, and localized loading/failed/expired states. `browser-plugin.client.spec.ts` — registration, inject faces, subagent address ownership, unknown-session refusal, and teardown disposal. 47 package tests, client typecheck, lint, and package dependency verification pass.

## Related

- [Plan review as a decision, not a question](2026-07-30-plan-review-presentation-intent.md) — the composer review surface these cards and previews route out of.
