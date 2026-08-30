# Agent Note: Do not ship an unverified persistent pwsh marker wait

Status: rejected — hosted macOS evidence did not prove the marker race; keep the existing prompt fallback until a reproducible cross-platform fix exists

English | [中文](2026-08-30-pwsh-marker-readiness.zh.md)

## Problem

The persistent PowerShell consumer can observe a printable prompt before a wrapped command's completion marker is available in the PTY readback. A proposed change treated `inferred_idle` as an incomplete observation and waited for the marker, while hosted macOS runs still lost command output or timed out. The same three real-PowerShell failures occur on the pre-upgrade baseline, so the available evidence does not establish an upgrade regression or a safe fix.

## Proposal

Keep the marker/readback loop for a result that has not reached a prompt, and use the existing prompt fallback when the terminal reports prompt completion. Revisit a marker-only wait only after a reproducible fixture demonstrates the delayed-marker ordering and proves bounded output, cancellation, reset, and subsequent-command behavior on macOS, Linux, and Windows.

## Alternatives considered

**Wait after every `inferred_idle` result.** Rejected: the hosted macOS run changed the existing clipped result into a timeout, and no cross-platform evidence shows that the marker will arrive before the command deadline.

**Increase the global idle-silence or handoff budget.** Rejected: it adds latency to every terminal dialect without proving foreground completion or repairing marker parsing.

**Ignore the hosted macOS failures.** Rejected as a product diagnosis, but retained as an external platform follow-up: the baseline has the same failures, so this release must not claim to have fixed them or weaken their assertions.

## Acceptance criteria

- A future marker-readiness change has a deterministic PTY fixture for prompt-before-marker ordering and a real-shell reproduction on each supported platform.
- The change preserves bounded deadlines, cancellation and shell reset, exact marker parsing, secret scrubbing, and the next-call cwd/environment state.
- Baseline and candidate results are compared before changing the release status or relaxing the real-PowerShell assertions.

## Risks

The current prompt fallback can return partial output when a shell reports readiness before the wrapper marker is readable. Keeping it is safer than an unbounded wait, but the macOS PowerShell integration gap remains open and requires a platform-specific investigation before a future fix is enabled.
