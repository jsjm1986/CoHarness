# Agent Note: stdin-wait departure must hold across consecutive polls

Status: implemented

English | [中文](2026-11-17-stdin-wait-departure-sustained.zh.md)

## Problem

`LocalSendOperation.acceptsStdinWait` treats any observed `inputWaiting` departure from the send's initial foreground group as proof the written line was consumed: a single `waiting === false` poll sets `initialForegroundLeftWait`, and the next `waiting === true` poll settles `stdin_read`. Line editors do not guarantee that stability — PSReadLine re-renders the pasted input with syntax highlighting across several chunk bursts, and between bursts the shell process genuinely blocks on the console read again. The coverage lane's `tool-pwsh-persistent preserves cwd and environment across calls` trace showed the sequence `true → false → true` sampled inside one echo render: the send settled 46ms after its write, before the command's start marker was ever emitted, and the tool returned the wrapper's own echo tail as the command output.

## Decision

A departure now must persist to count: `acceptsStdinWait` keeps a `foregroundBusyPolls` counter, increments it on each consecutive `waiting === false` poll, and arms `initialForegroundLeftWait` only at the second consecutive busy observation; any `waiting === true` poll resets the counter without disarming. `setInitialForeground` seeds the counter to 1 when the initial foreground is already busy, so an already-departed group needs one more confirming poll rather than settling on its first return.

One flicker poll therefore leaves the send open — echo churn cannot settle it — while a real execution, which holds `inputWaiting === false` for many polls, arms the departure and a later return to the wait still settles `stdin_read` as before.

## Alternatives considered

- Gating the probe path on the prompt-evidence arm (`promptEvidenceArmed`) — rejected: PSReadLine's `> `-prefixed echo fragments defeat positional echo absorption, so unabsorbable echo itself sets `sawNonPromptOutput` and would arm the same premature settle. The output-evidence gate and the foreground-gate answer different questions and composing them that way fixes nothing.
- Counting a single `false` poll only when `sawNonPromptOutput` is also set — rejected for the same reason: the churned fragments are unabsorbable and flip the flag during the very render the check is meant to outlast.
- Requiring a time-based busy duration instead of a poll count — rejected: the poll interval is already the sampling quantum; a duration threshold re-derives the same count with more arithmetic and an extra clock read per poll.
- Leaving single-poll departures as evidence — rejected by the CI trace: the flicker is a real sample, not measurement noise, and under coverage-lane load it recurs often enough to fail `tool-pwsh-persistent` repeatedly.

## Consequences

- A command whose execution window is shorter than two polls loses its fast `stdin_read` settle only when it also produced no prompt-marker path; it then settles on the prompt evidence or the silence tier — a latency regression of one polling tier, never a wrong settle.
- Existing pre-write-wait tests that scripted one busy poll were updated to script a sustained departure; their contract — a pre-write wait alone never settles, and a departure-then-return does — is unchanged.
- The probe path no longer contradicts the note [Prompt settlement requires post-write output evidence](../architecture/2026-11-16-prompt-evidence-requires-post-write-output.md): both paths now demand evidence a single repaint or flicker cannot supply.

## Verification

- `packages/terminal/terminal-bash` suite — 122/123 (1 skipped) locally, including the new `does not settle on a single-poll stdin-wait departure flicker during input echo` regression; stashing the `session.ts` change makes it fail deterministically.
- The regression replays the coverage-lane interleaving: `waiting → one busy poll → waiting` leaves the send unsettled, and `waiting → two busy polls → waiting` settles `stdin_read`.
