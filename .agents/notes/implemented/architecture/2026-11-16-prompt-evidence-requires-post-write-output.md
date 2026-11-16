# Agent Note: Prompt settlement requires post-write output evidence

Status: implemented

English | [中文](2026-11-16-prompt-evidence-requires-post-write-output.zh.md)

## Problem

`LocalPtySession.pollReadiness` settles a send as `stdin_read` when the controlled prompt marker, its printable tail, and the shell's foreground group line up inside the send's window. The evidence had no generation boundary: a trailing prompt repaint emitted by the previous command can land inside a later send's window — the send's `resetReadinessEvidence` has already run, so the stale chunk sets `promptSeen`/`promptTextSeen`, the shell legitimately owns the foreground group (it sits at that prompt), and the send settles before its written input was ever consumed. `tool-pwsh-persistent` then renders the partial delta — the prompt alone — as the command's output.

The CI trace showed the whole race in one interleaving: the `observe` send wrote its 417-unit wrapper at +1595ms, the previous command's `\x1b]133;D;0\x07dsh> ` repaint arrived in the same millisecond, `inspectForeground` reported `inputWaiting` on the pre-consumption poll, and the send settled `stdin_read` after 16ms. Coverage-lane load widened the interleaving window enough to make it recur; the same collision is possible on any timing.

## Decision

Sends that write input must observe output a prompt redraw cannot supply before their prompt path may settle. `LocalSendOperation` carries two evidence bits: `expectsEcho`, set when `beginSend` actually writes input, and `sawNonPromptOutput`, set when a sanitized chunk carries text the prompt cannot explain — anything beyond the chunk's own `promptTail`, not equal to a `CONTROLLED_PROMPT` fragment, and outside an incomplete prompt-tail window. `pollReadiness`'s prompt branch now also requires `operation.promptEvidenceArmed`.

Empty sends (`text: ''`) never set `expectsEcho` and keep settling on prompt evidence alone; they are the tool loop's wait iterations and lose nothing by early return. The probe path (`acceptsStdinWait`) already required the foreground to have left its input wait since the send began and is unchanged.

## Consequences

- A send that writes input can no longer settle `stdin_read` on a bare prompt that predates its own echo, output, or marker bytes; the command proceeds, its markers land, and the settle happens on the real post-command prompt.
- Fake-terminal tests that emitted a post-write prompt with no echo were updated to include the echo a real tty always produces; the new regression test replays the exact CI interleaving (stale repaint inside the send window, then echo, output, and prompt).
- A send whose input is consumed while `ECHO` is off degrades to the silence tier rather than the fast prompt path: the outcome stays correct and the tool loop still observes the command's markers.
- The `pty-delayed-signal-prompt` TODO's marker-generation boundary is realized for the prompt-settle path: evidence before the send's own output cannot arm settlement.

## Alternatives considered

- Reusing `acceptsStdinWait`'s `initialForegroundLeftWait` memory on the prompt path — rejected: the poll samples `inputWaiting` at `pollIntervalMs`, and a fast command can consume input, run, and return to the wait inside one interval. The missed transition would degrade every fast send to the silence bound, which the `stdinReads >= 6` pinning exists to forbid.
- Re-detecting the written bytes inside the pty stream (match the wrapper's echo) — rejected: PSReadLine re-renders input with interleaved highlighting, so the echo is not byte-stable; "any non-prompt output" is the robust consumption signal.
- Handling it in `tool-pwsh-persistent`'s `stdin_read` branch by waiting for the start marker before returning — rejected: the tool cannot distinguish an interactive child legitimately reading stdin (which must return quickly) from an unconsumed write; only the terminal layer sees the foreground group and the stream ordering.

## Verification

- `packages/terminal/terminal-bash/tests/session.spec.ts` — 57/57, including the new `does not settle a send on a prompt repaint that lands before its own echo` replaying the CI failure interleaving.
- `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` and the whole `terminal-bash` + `tool-pwsh-persistent` suite — 166/167 (1 skipped) locally, covering the real pwsh composition the CI failure came from.
