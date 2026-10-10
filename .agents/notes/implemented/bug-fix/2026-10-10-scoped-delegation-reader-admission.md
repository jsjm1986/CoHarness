# Agent Note: Delegated policy append routes scoped scope through the authority writer

Status: implemented

English | [中文](2026-10-10-scoped-delegation-reader-admission.zh.md)

## Problem

`appendDelegatedPolicyOverrides` appended `gateway/execution { kind: 'inherit', scope }` to the child's log directly. When the captured `ExecutionInheritance` carries a `scopeId` — every session under a managed, scoped deployment — the `gateway-execution` projection requires a `gateway/scoped-execution` reader-admission event to precede the first scoped event, and no such event was ever emitted. The child log became unreadable at first fold, and every delegation under a scoped parent — `spawn_teammate`, one-shot subagent starts, and continuable children — failed with `scoped inheritance requires its reader admission event`, surfacing as a `failed` Team member or a rejected child run.

## Decision

`appendDelegatedPolicyOverrides` now takes the child's `Context` and delegates the scoped write to `executionAuthorityOf(childCtx).inherit(session, scope)` — the service method whose contract is exactly "persist captured restrictions inside the unpublished child setup". That writer emits `gateway/scoped-execution` before the first scoped event only when the folded log lacks one, so a fork seed that already carries admission is not duplicated. When no authority provider is mounted, an unscoped capture still appends directly (unmanaged deployments never produce a `scopeId`), while a scoped capture throws rather than persisting a log its own projection would refuse.

## Alternatives considered

**Append `gateway/scoped-execution` unconditionally before the inherit event.** Rejected: it would duplicate the admission marker on forked children whose seed already carries it, and it re-implements the ordering rule at a second call site, where it can drift from the owning projection.

**Gate admission on `scopeId` presence inside this helper.** Rejected: same duplication objection; the "already admitted" check requires the projection fold that only the authority writer performs.

## Consequences

Scoped parents can delegate again: the child's durable prefix reads `subagent/descriptor`, `gateway/scoped-execution`, `gateway/execution inherit`, then the remaining delegation policy events, and the member/session passes its own projection fold. The fail-loud branch turns a missing authority provider into an explicit error instead of a corrupt child log.

## Verification

`child-agent.spec` now asserts the capture routes through `authority.inherit` (recording the exact session), that an unscoped capture still appends directly with no provider mounted, and that a scoped capture with no provider throws and writes nothing. The in-process driver spec mounts an authority double and asserts `inherit` ran exactly once during start. The `gateway-execution` authority suite already pins the admission write and the no-duplicate-on-seeded-fork case. All 797 subagent and in-process-driver tests pass.
