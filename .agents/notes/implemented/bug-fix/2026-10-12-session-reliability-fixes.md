# Agent Note: Session reliability fixes — wake cap, executable errors, opaque Team content, goal withdrawal, plan dismissal

Status: implemented

English | [中文](2026-10-12-session-reliability-fixes.zh.md)

## Problem

Five independent reliability defects, all confirmed by upstream source comparison:

1. `tool-jobs` capped `maxConsecutiveWakes` at 10 by default, so an unattended agent chaining background work stalled silently after the eleventh completion.
2. `terminal-controller` shell discovery and the SSH helper identified `SubprocessExecutableNotFoundError` by `instanceof`, which fails across peer-realm boundaries and surfaced an unclassified error where a missing executable was expected.
3. `agent-team` validated unknown plugin content blocks through `z.object().loose()`, which reconstructs the value and drops own `__proto__` keys and other exotic own properties on mailbox fold.
4. `goal-round-driver` left a withdrawn goal attempt's queued round prompt in the agent inbox after cancellation, so later human input waited behind a dead goal message.
5. `plan-mode` treated a dismissed `exit_plan_mode` review as a tool failure, leaving the turn unsettled and emitting an error result.
6. `headless` awaited only parent idle after the task turn, so a still-running continuable child's settlement notice — and the final parent answer it drives — was lost when the process exited.

## Decision

1. Port upstream `b6775f6d4f5` plus `2d653be7b0e`: drop the `.default(10)` so wake delivery is unbounded unless an operator sets `maxConsecutiveWakes`.
2. Port upstream `f37f19ab43a`: match executable errors by `name` in both consumers, drop `SubprocessExecutableNotFoundError` from `peerRequiredHostExports`, and add the `requiredServicePeers` policy lane so `api-terminal-controller` keeps its `dsh-subprocess` peer declaration with only type imports.
3. Adapt upstream `1e6630a8568` onto the CoHarness fold architecture: validate only the `type` tag of unknown content blocks and preserve the decoded object verbatim, keeping strict validation for known variants. The upstream projection checkpoint bump does not apply — CoHarness rebuilds state from the log on every fold, so no checkpoint version exists to invalidate.
4. Port upstream `9a8d21dfe75`: at the idle checkpoint, a cancelled attempt that exactly matches the armed goal revision pauses the goal; a queued attempt message is removed from `agent.inbox`; settlement failure warns and disarms.
5. Port upstream `18a4bc4093c`: the `exit_plan_mode` output schema accepts `{ approved: boolean }`; `UserQuestionError` `ASK_CANCELLED` concludes the turn and returns `{ approved: false }` with plan mode still active; other errors rethrow.
6. Adapt the `waitForChildren` half of upstream `a1da7bcfb96` onto `ContinuableActivationRegistry`: join descendant work until no resident Activation is busy, closing, or mid-materialization, then have the headless runner loop `whenIdle` + `waitForChildren` until the parent stays idle with an unchanged Session sequence. The commit's settlement-message `structured`/`diagnostic` relay does not apply — CoHarness `ActivationTerminal` has no structured channel to relay (a separate feature gap).
7. Port upstream `1d37aabe99c`: for `all-prompts` title revisions, supply the current provider-generated title as structured JSON with preservation instructions so an adequate title survives verbatim; fallback and user-authored titles stay out of the input, and the title counts toward `maxInputBytes`.
8. Port upstream `b981255be6d` plus `0516f66d832` onto the per-directory dedup model: content duplicates of baseline-retained files stay eligible for reconciliation (a duplicate of a budget-omitted winner inherits that omission), and when any candidate of a directory group — including a hidden duplicate — cannot be read, the whole group keeps its last-good state with every member's absolute path reserved against aliased republication.
9. Port upstream `02f54230705`: model discovery resolves the route credential first and returns an empty catalog on `MISSING_CREDENTIAL`, so an unconfigured DeepSeek route disappears from model selectors while keeping its settings entry.
10. Port upstream `59ba1321eba`: allocate Windows terminals with node-pty's bundled console host (`useConptyDll: true`, win32 only) so the persistent-pwsh readiness tail is emitted verbatim.

## Alternatives considered

**Keep a small default wake cap.** Rejected: the cap silently stalls unattended chains that rely on wakes, and operators who need a bound can still set the field; upstream converged on unbounded after review.

**Keep `instanceof` for executable errors.** Rejected: peer-realm duplication is a supported composition, so identity checks are unreliable; the dependency gate now records the same rule as `requiredServicePeers` instead of a peer-required export.

**Take upstream's projection checkpoint bump for the Team fix.** Rejected: CoHarness has no persisted projection checkpoint to invalidate — fold is pure replay, so validating the tag and preserving the decoded value is the complete port.

## Consequences

Unattended agents wake for every completion by default; a configured cap keeps its stall semantics. Missing executables report as missing on every realm. Team mailbox fold preserves opaque plugin JSON including own `__proto__`. Cancelling a queued goal round withdraws its inbox prompt, so human input runs next. Dismissing a plan review settles the turn as a negative result rather than an error. A headless run now ends only after every continuable descendant has settled and delivered its notice. A follow-up prompt no longer rewrites an adequate generated title, while a user-set title still wins outright. A failed or hidden instruction candidate can no longer let its directory publish a partial transition, and a duplicate of retained content can surface when its winner changes. An unconfigured DeepSeek route no longer offers unusable models, and persistent Windows shells reach readiness on the bundled console host.

## Verification

`tool-jobs`/`goal`/`plan`/`agent-team`/`terminal-controller`/`ssh` 799 tests; `verify-package-dependencies` 44 spec tests plus the live gate over 63 packages; `exit_plan_mode` integration proves a dismissed review ends the turn without another model request; goal regression proves later human input runs after a queued round is withdrawn; `subagent` 959 tests including registry-level `waitForChildren` joins; headless regression proves a settlement-driven second turn is awaited before exit; `session-title-llm` 78 tests pin the JSON-framed current title, exact stability instructions, and byte-limit boundaries; `agent-instructions` 160 tests cover group freeze across metadata/read failure and budget-omission inheritance; `llm-deepseek` 529 tests plus `llm-deepseek-api-key` 4 tests cover the credential-gated catalog; `subprocess-local` 360 tests pin `useConptyDll` per platform.

## Related

- [Durable-path safety fixes](2026-10-12-durable-path-safety-fixes.md) — same alpha.2 alignment campaign.
- Upstream commits: `b6775f6d4f5`, `2d653be7b0e`, `f37f19ab43a`, `1e6630a8568`, `9a8d21dfe75`, `18a4bc4093c`, `a1da7bcfb96` (partial), `1d37aabe99c`, `b981255be6d`, `0516f66d832`, `02f54230705`, `59ba1321eba`.
