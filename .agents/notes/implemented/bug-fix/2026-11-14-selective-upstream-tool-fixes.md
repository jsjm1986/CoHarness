# Agent Note: Selective backport of upstream tool-layer fixes (rc.2..v0.2.2-rc.3)

Status: implemented

English | [中文](2026-11-14-selective-upstream-tool-fixes.zh.md)

## Problem

The upstream `v0.2.2-rc.3` line shipped eleven `fix(tools)`/`fix(executor)` commits. Reviewing them against our tree found three real defects we share and several that target upstream-only machinery:

- Persistent Bash launched `stty -echo` but left history expansion enabled, so model commands containing `!` were rewritten or discarded by interactive-shell expansion before execution (upstream `967ba4c`).
- `ToolExecutionPipeline`/`dispatchToolBody` classified a tool body that threw the signal's cancellation reason — or a bare `AbortError` — after the caller aborted as an ordinary tool failure instead of `TOOL_ABORTED` (`fc6afa9`).
- `update_goal` rejected populated fields irrelevant to the selected action and `grep` rejected an exact empty `include` — both surfaced as tool errors for input models legitimately emit (`080a2c6`, `4e4badb`).

## Decision

Ported the shared fixes and recorded the rest as not applicable:

- `tool-bash-persistent` setup runs `stty -echo; set +H`.
- `dispatchToolBody` maps an unclassified error to `AbortError`/`TOOL_ABORTED` only when it is the signal's own `reason` or carries the `AbortError` name; `HarnessError` identities and ordinary domain errors thrown after abort keep their original classification.
- `update_goal` schema descriptions mark non-applicable fields as ignored; `edit` forwards only `objective`/`max_goal_rounds`, `blocked` still requires a non-empty `blocked_reason`, and `presentCall` only displays fields belonging to the action. `grep` normalizes `include: ''` to omitted while whitespace-only values remain invalid; its presentation drops the empty filter suffix.
- Not applicable: executor unload/settlement, locale metadata, and PTC-activation commits live in `tool-executor-*` packages we have not adopted; service-subject retention (`c0661b8`) and executor registry notifications (`e727a3b`) target a pipeline/`setExecutor` architecture we do not have; plan-mode conditional admission (`3ce7312`) assumes an admission seam absent from our registration, so our explicit `agent`/`loggedActive` checks remain the enforcement point; sandbox description rewording was skipped because our shared `sandboxPermissionsDescription` helper's semantics differ intentionally.

## Alternatives considered

**Raw cherry-pick of each upstream commit.** Rejected: the tool executor and pipeline files differ structurally, so source-level adaptation is required anyway.

**Also removing our resume-paused prohibition and blocked-round threshold to match upstream.** Rejected: both are deliberate local authority rules; upstream's argument-relaxation does not imply relaxing transitions.

## Consequences

Cancellation from a started tool body now reports `TOOL_ABORTED` consistently, interactive Bash accepts `!` literals, and goal/grep argument surfaces tolerate ignored fields instead of erroring. The behavioral changes are additive relaxations; no consumer relied on the stricter rejections beyond their own assertions, which were updated.

## Verification

`packages/core/tools` spec gains three regression cases covering reason-thrown, `AbortError`-thrown, and non-cancellation errors after abort; `tool-goal` spec updated to the ignore-not-reject semantics plus populated-fields coverage per action; `tool-fs-search` spec covers empty `include` in parse and presentation. All three specs pass in full (143, 32, 113 tests).
