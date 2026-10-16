# Agent Note: Schedule subagent ownership — target refusal and delegated-caller refusal

Status: implemented

English | [中文](2026-10-13-schedule-subagent-ownership.zh.md)

## Problem

A delegated child's Session can never receive a delivered reminder: delivery resolves the bound Session through the shared Session controller, which rejects the live Agent of a delegated child. Before this fix, `ScheduleService.create` and `ScheduleService.update` armed tasks for such Sessions anyway, so the record stayed permanently overdue and retried on every drive, and the four schedule tools let a delegated caller manage reminders directly. Upstream commits `96c421d9857`, `500295b2bdf`, `699f1a8dc18`, and `1b1b09e1fbe` close both directions; the local architecture needs the same rule expressed through different layers.

## Decision

- `ScheduleService.create` throws `ScheduleInputError('subagent_session')` and `ScheduleService.update` returns the non-mutating `{ code: 'subagent_session' }` result when the target Session's live Agent reads `delegationDepthOf(agent) > 0` — the accounting the delegation cap itself enforces, carried by the persisted session header across a cold resume. `list`, `catalog`, `history`, and `delete` stay open so stored tasks remain inspectable and removable.
- All four schedule tools (`schedule_create`, `schedule_list`, `schedule_delete`, `schedule_update`) check `delegationDepthOf(exec.agent)` before dispatch and return the stable `{ code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }` value; `subagent_session` joins `ScheduleInputError`'s code union, the `SubagentSessionError`/`ScheduleToolError` public unions, the update-result union, and the tool output schemas.
- `timingError()` maps `subagent_session` to a dedicated `timing.subagentSession` string in both locales, so the management editor renders the refusal reason rather than `rule.error.unknown`.

## Alternatives considered

**Port the upstream `toolFilter.deny` preset rows.** Rejected for CoHarness: our schedule tools are agent-scoped registrations mounted on root Agents by `registerScheduleTools`, not globally registered names, so a `deny` entry would fail `tools.restrict()`'s unknown-name check at startup. Root-only registration already keeps the tools out of a child's prompt; the explicit per-tool refusal covers any direct execution path.

**Refuse on routing ownership instead of delegation depth.** Upstream's first pass keyed on `hasApiSessionSubagentOwner` and later narrowed to depth alone; we follow the final form directly, since the depth header is the accounting the delegation cap enforces.

## Consequences

A task can no longer be armed or re-armed for a Session delivery can never reach, through the model tools, the management UI, or any other service consumer including automation. Delegated callers see one stable refusal code from every schedule tool. Existing tasks bound to child Sessions remain listed and deletable.

## Verification

`packages/schedule/schedule/tests/subagent-ownership.spec.ts` pins service create/update refusals against a delegated child's Session plus continued list/delete access; `tools.spec.ts` pins all four tools returning the refusal for a delegated caller; `task-manager-page.client.spec.tsx` renders `timing.subagentSession` on the non-mutating update result. Schedule and ui-schedule suites pass (1626 tests), clean typecheck, and the package-dependency policy gate accept the new `dsh-subagent` edge.

## Related

- [Scoped subagent limits](../architecture/2026-09-23-scoped-subagent-limits.md) — the delegation-depth accounting this refusal reads.
- [Session reliability fixes](2026-10-12-session-reliability-fixes.md) — same alpha.2 alignment campaign.
- Upstream commits: `96c421d9857`, `500295b2bdf`, `699f1a8dc18`, `1b1b09e1fbe`.
