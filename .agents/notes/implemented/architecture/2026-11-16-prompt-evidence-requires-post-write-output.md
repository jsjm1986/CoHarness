# Agent Note: Prompt settlement requires post-write output evidence

Status: implemented

English | [中文](2026-11-16-prompt-evidence-requires-post-write-output.zh.md)

## Problem

`LocalPtySession.pollReadiness` settles a send as `stdin_read` when the controlled prompt marker, its printable tail, and the shell's foreground group line up inside the send's window. The evidence had no generation boundary: a trailing prompt repaint emitted by the previous command can land inside a later send's window — the send's `resetReadinessEvidence` has already run, so the stale chunk sets `promptSeen`/`promptTextSeen`, the shell legitimately owns the foreground group (it sits at that prompt), and the send settles before its written input was ever consumed. `tool-pwsh-persistent` then renders the partial delta — the prompt alone — as the command's output.

The CI trace showed the whole race in one interleaving: the `observe` send wrote its 417-unit wrapper at +1595ms, the previous command's `\x1b]133;D;0\x07dsh> ` repaint arrived in the same millisecond, `inspectForeground` reported `inputWaiting` on the pre-consumption poll, and the send settled `stdin_read` after 16ms. Coverage-lane load widened the interleaving window enough to make it recur; the same collision is possible on any timing.

## Decision

Sends that write input may attribute a prompt marker to themselves only after evidence a stale redraw cannot supply. `LocalSendOperation` records the written input (`noteInput`) and absorbs its echo: `absorbEcho` matches sanitized chunks against the whitespace-normalized input — including wrapped PSReadLine redraw fragments and whitespace-only submit echoes — without arming anything. `promptEvidenceArmed` holds once the send sees real output (`sawNonPromptOutput`: text that is not prompt tail, not a `CONTROLLED_PROMPT` fragment, and not absorbable input echo) or once the echo replay completes (`echoMatched` covers the input). A real tty echoes input before it prints the next prompt, so either signal marks the boundary a stale repaint cannot cross.

`promptSeen` itself is gated on the armed state: a marker chunk arriving while the active send is unarmed is discarded as the previous command's redraw and sets none of the prompt evidence. `pollReadiness`'s prompt branch keeps requiring `promptEvidenceArmed` as well.

Echo absorption must not swallow literal output that also appears inside the input. Persistent shells run `stty -echo`, so no echo arrives at all — yet the wrapper's own `printf '<start marker>'` output is a substring of the written wrapper, and matching it as echo would leave `exec`-replaced shells unarmed forever (their only settle path is the replacement shell's prompt). `absorbEcho` therefore matches positionally — `lastIndexOf(fragment, echoMatched)` — so contiguous echo, overlaps, and backward re-renders absorb while output occurring ahead of echo coverage stays evidence.

Empty sends (`text: ''`) never set `expectsEcho` and keep settling on prompt evidence alone; they are the tool loop's wait iterations and lose nothing by early return. The probe path (`acceptsStdinWait`) already required the foreground to have left its input wait since the send began; the departure must now hold across two consecutive polls, recorded in [stdin-wait departure must hold across consecutive polls](../bug-fix/2026-11-17-stdin-wait-departure-sustained.md).

## Consequences

- A send that writes input can no longer settle `stdin_read` on a prompt repaint that lands mid-echo or before its own output; the command proceeds, its markers land, and the settle happens on the real post-command prompt.
- Input echo is not consumption evidence either: the second CI signature returned the wrapper's echo tail as the command output because the redrawn input armed the stale prompt. Absorption also handles carriage-return/newline submit echoes, which carry no visible text.
- `stty -echo` shells (the persistent bash backend) emit no echo; their sends arm on the wrapper's marker output, which positional matching keeps distinct from echo even though the marker text is embedded in the input.
- Silent commands (`cd`, `export`) still settle on their prompt: the completed echo replay is the consumption evidence, so a post-echo prompt is accepted while a mid-echo one is not.
- Fake-terminal tests that emitted a post-write prompt with no echo were updated to include the echo a real tty always produces; regression tests replay both CI interleavings (stale repaint before the echo, and a stale prompt inside a partial input echo).
- A send whose input is consumed while `ECHO` is off, or whose echo never matches the written bytes, degrades to the silence tier rather than the fast prompt path: the outcome stays correct and the tool loop still observes the command's markers.
- The `pty-delayed-signal-prompt` TODO's marker-generation boundary is realized for the prompt-settle path: evidence before the send's own output or echo cannot arm settlement.

## Alternatives considered

- Reusing `acceptsStdinWait`'s `initialForegroundLeftWait` memory on the prompt path — rejected: the poll samples `inputWaiting` at `pollIntervalMs`, and a fast command can consume input, run, and return to the wait inside one interval. The missed transition would degrade every fast send to the silence bound, which the `stdinReads >= 6` pinning exists to forbid.
- Re-detecting the written bytes inside the pty stream (match the wrapper's echo) — partially adopted: PSReadLine re-renders input with interleaved highlighting, so the echo is not byte-stable and an exact match is infeasible; whitespace-normalized substring absorption recognizes the fragments without depending on redraw layout, and saturating the match arms silent commands.
- Handling it in `tool-pwsh-persistent`'s `stdin_read` branch by waiting for the start marker before returning — rejected: the tool cannot distinguish an interactive child legitimately reading stdin (which must return quickly) from an unconsumed write; only the terminal layer sees the foreground group and the stream ordering.

## Verification

- `packages/terminal/terminal-bash/tests/session.spec.ts` — 59/59, including `does not settle a send on a prompt repaint that lands before its own echo`, `does not settle on a stale prompt inside a partial input echo` (the coverage-lane echo-tail signature), and `settles a silent command on its post-echo prompt`.
- `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` and the whole `terminal-bash` + `tool-pwsh-persistent` suite — 168/169 (1 skipped) locally, covering the real pwsh composition the CI failure came from.
