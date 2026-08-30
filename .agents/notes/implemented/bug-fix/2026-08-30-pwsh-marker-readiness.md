# Agent Note: Do not return persistent pwsh output on inferred idle

Status: implemented

English | [中文](2026-08-30-pwsh-marker-readiness.zh.md)

## Problem

The macOS PTY backend may report `inferred_idle` when PowerShell has displayed its prompt but the wrapped command's completion marker has not reached the terminal buffer. Returning the partial viewport at that point dropped ordinary command output and made the persistent pwsh path fail on hosted macOS.

## Decision

The persistent pwsh consumer returns prompt fallback output only for an exact `stdin_read` result. An `inferred_idle` result continues the existing marker/readback loop until the marker arrives, the shell exits, or the command deadline expires. This follows the terminal contract that inferred idle does not prove foreground completion.

## Verification

The persistent pwsh tool suite covers a prompt-visible inferred-idle result followed by a marker-bearing read and passes. The terminal PowerShell integration checks use a platform-tolerant readiness assertion and a longer output budget for hosted macOS startup. Bash behavior and the existing timeout/reset paths remain unchanged.

## Alternatives considered

**Treat every prompt-visible result as complete.** Rejected because prompt visibility and wrapped-command completion are separate events on a PTY.

**Increase the global idle-silence default.** Rejected because it adds latency to every terminal dialect and does not establish that a foreground command has completed.

**Ignore the hosted macOS failures.** Rejected because the same race can lose model-visible command output in any slow PowerShell host.

## Consequences

Persistent pwsh commands may wait for the marker after an inferred-idle observation, bounded by the configured command timeout. Commands that intentionally replace or consume the shell still use the existing exact-readiness fallback and reset behavior.
