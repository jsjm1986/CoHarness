# Agent Note: Re-key workflow member navigation into presentation space

Status: implemented

English | [中文](2026-10-04-workflow-member-session-key.zh.md)

## Problem

Durable `workflow/agent-start` events carry a raw wire `childId` (`SessionId`). `WorkflowRunPanel` compared that value directly against `sessions.ids`/`sessions.byId`, but the `sessions` service is always `SessionRuntimePool`, whose projection rewrites every id through `clientSessionKey` into `dsh-session:v1:` keys. A raw id can never appear in the list, so `navigableMembers` always returned `[]`, the member row never received a click handler, and workflow member navigation was dead in every deployment.

## Decision

The panel re-keys durable ids before touching the sessions list, following the ui-schedule and agent-team normalization patterns. `WorkflowRunInjected` gains `sessionKey(id, parentId)`, wired in `apply` to `ctx.sessions.keyFor(id, runtimeIdentityFor(parentId))` with an identity fallback when the service lacks `keyFor`. `navigableMembers` and `MemberRow` compare and open the qualified key; `openSession` receives the presentation key because `pool.open` accepts qualified ids directly. Durable events stay raw — only the comparison boundary re-keys.

## Files

- `packages/client/ui-workflow-run/src/client/index.ts` — `sessionKey` injected from `ctx.sessions`.
- `packages/client/ui-workflow-run/src/client/WorkflowRunPanel.tsx` — `navigableMembers`, `PhaseSection`, and `MemberRow` operate on presentation keys.
- `packages/client/ui-workflow-run/tests/workflow-run.client.spec.ts` — regression covering a raw `childId` against a runtime-qualified list.

## Consequences

A running subagent member now opens its session from the workflow panel when the pooled list proves parentage. Other surfaces that read `childId`-style durable ids against `sessions.ids`/`byId` need the same `keyFor` normalization; new code should compare in presentation space, never wire space.
