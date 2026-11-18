# Agent Note: A returned stdin wait holds until the output stream goes quiet

Status: implemented

English | [中文](2026-11-19-stdin-wait-return-holds-until-output-quiet.zh.md)

## Problem

`LocalPtySession.pollReadiness` settles a send as `stdin_read` on two paths. The prompt path requires the stream to have been quiet for one poll (`idleFor >= pollIntervalMs`) after the prompt evidence lands. The exact path — `acceptsStdinWait` accepting an observed return to `inputWaiting` — had no quiet requirement at all.

The wait's return is observed ahead of the byte stream. A shell that just resumed its stdin read has already emitted everything it will, but the final bytes can still be in flight between the kernel pty buffer and the Node stream. Settling on the bare observation hands those bytes to the next send's capture window.

The coverage lane's `tool-pwsh-persistent` trace showed the whole interleaving: the `large-output` send (`1..12050 | ForEach-Object { $_ }`) settled `stdin_read` after 617ms with `promptSeen=false`, its last observed chunk — flood line 12031 — having arrived 4ms earlier. The remaining ~20 lines, the command's `END` marker, and its prompt all landed inside the next (`exit`) send's window, which itself settled `stdin_read` in 16ms on the pre-consumption wait. `partialOutput` then found no `START` marker anywhere for `exit`, fell back to the whole capture as `incomplete`, and the tool returned `LOST_PREFIX` followed by flood lines 12038–12045 — the previous command's tail presented as the next command's output. The same spec failed repeatedly across coverage and windows-native lanes on otherwise unrelated PRs.

## Decision

The exact settle now requires the same quiet bound the prompt path already required: `pollReadiness` settles `stdin_read` on an accepted wait-return only when `idleFor >= pollIntervalMs` — no output chunk has arrived within the last polling interval. One quiet poll drains the in-flight tail into the settling send's own buffer, so the next send starts its capture window after the previous command's bytes.

The departure side of `acceptsStdinWait` is unchanged: arming still requires the sustained busy observation recorded in [stdin-wait departure must hold across consecutive polls](2026-11-17-stdin-wait-departure-sustained.md); only the acceptance of the return gained the drain condition. The interactive-child case (`processGroupId !== initialForegroundPgid`, which returns `inputWaiting` directly) inherits the gate at the same site: a child's final output burst also drains before its settle.

## Alternatives considered

- Requiring the command's `END` marker or prompt on this path too — rejected: the exact path exists precisely for sends whose output carries no prompt marker (silent commands under churn, interactive children), and marker semantics belong to `tool-pwsh-persistent`, not the terminal layer.
- Attributing post-settle chunks back to the previous send's buffer — rejected: the session cannot distinguish a settling command's drained tail from a concurrent writer's output; the quiet window is the only boundary the stream itself exposes.
- A fixed drain delay independent of the stream — rejected: `pollIntervalMs` is already the sampling quantum the prompt path uses, so the bound scales with the configured cadence and adds no latency once the stream is actually quiet.

## Consequences

- A send whose bytes are still arriving settles `stdin_read` at most one poll later than the observed wait-return; a command that has already gone quiet pays nothing — `exactProbeAfterMs` (150ms default) typically exceeds one poll (50ms) anyway.
- A command's `END` marker and prompt now land inside its own send window, so `tool-pwsh-persistent`'s per-command marker association and scrollback accounting hold again; a returned `incomplete`/`LOST_PREFIX` once more means real scrollback loss rather than an in-flight drain.
- The invariant from [Prompt settlement requires post-write output evidence](../architecture/2026-11-16-prompt-evidence-requires-post-write-output.md) now covers both fast paths symmetrically: neither settles on evidence a mid-flight stream can still invalidate.
- `inferred_idle` remains the declared degradation tier and needs no drain gate — it fires only after `idleSilenceMs` of silence, which already bounds the tail.

## Verification

- `packages/terminal/terminal-bash/tests/session.spec.ts` — 62/62, including the new `holds a returned stdin wait until the output stream goes quiet for one poll`, which replays the CI interleaving: two busy polls arm the departure, the wait returns while a `tail` chunk is still arriving, and the send settles only after one quiet poll. Stashing the `session.ts` change makes it fail deterministically at the unsettled assertion.
- `packages/terminal/terminal-bash` suite — 123/124 (1 skipped); `packages/shell/tool-pwsh-persistent` suite including the real `loader-composition.spec.ts` pwsh composition passes locally.
