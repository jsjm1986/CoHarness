# Agent Note: The approval panel projects localized displayReason through the wire

Status: implemented

English | [中文](2026-10-15-approval-display-reason-projection.zh.md)

## Problem

The ask-decision contract already carries an optional localized `displayReason` (`PreToolDecision`, `ApprovalRequestEvent`, the auto-review and sandbox askers), but the prompt chain dropped it at the wire: the apiproxy's pending registry forwarded only `reason` into the `approval/requested` mux frame, so the composer's approval panel always rendered the audited English reason even under a Chinese locale. The upstream source is the ask-fallback fix `0a134ef94ef` (its `approval` localization feature `12c9dd599e7` predates it; both are inside alpha.2).

## Decision

`displayReason` now travels the whole request path: the `approval/requested` frame type, its zod schema (`{ en: string }` plus open locale keys), and the proxy's pending registry forward it beside `reason`; the client `PendingApproval` domain face exposes it; the `conversation.composer` registration injects `resolveReason` bound to `ctx.locale.resolveText`; `ApprovalPanel` renders the resolved copy when a map exists and falls back to `reason`, then the escalation copy. The audit pair `approval/asked`/`approval/decided` keeps logging only `reason` — `displayReason` is presentation-only and never persists, matching the upstream contract.

## Alternatives considered

**Localize at the asker into `reason` itself.** That is what prompted the upstream fix: the durable `approval/asked` event must stay in the auditable English text, so presentation localization has to ride beside it, not inside it.

**Resolve the map in the panel without an injected seat.** Components own no service access; the entry's `inject` is the sanctioned binding point and keeps the map type identical to the wire's.

## Consequences

Approval prompts from `kind: 'ask'` decisions localize under the active locale's fallback chain (English required in the map). The `PendingApproval.reason` accessor is unchanged for consumers that need the audited text. Schema validation admits locale keys beyond `en`/`zh` without enumerating them.

## Verification

`api-proxy-approval.spec.ts` asserts the requested frame carries both the audited reason and the map through ask → broadcast → replay. `approval-panel.client.spec.tsx` renders the resolved Chinese copy when a map exists, the verbatim reason without one, and the escalation fallback with neither. The rpc-schemas spec corpus still passes with the widened frame.

## Related

- [2026-08-28 auto review](../feature/2026-08-28-auto-review.md) — the asker whose denials produce localized display reasons.
- [2026-07-23 Web permission and approval](../feature/2026-07-23-web-permission-and-approval.md) — the composer takeover this panel occupies.
