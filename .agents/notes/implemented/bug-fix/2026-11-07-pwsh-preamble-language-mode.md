# Agent Note: Encoding preamble is gated on FullLanguage

Status: implemented

English | [中文](2026-11-07-pwsh-preamble-language-mode.zh.md)

## Problem

The `pwsh` tool's encoding preamble assigns `[Console]::OutputEncoding` and `$OutputEncoding` through type member writes. The Windows ACL sandbox can confine the shell into ConstrainedLanguage mode, where both writes are denied with `CannotCreateTypeConstrainedLanguage`. The preamble threw on every call: output stayed UTF-8 (pwsh 7 defaults), but stderr gained a non-terminating error pair per invocation, and on the Windows PowerShell 5.1 fallback the OEM codepage still leaked through the noise.

## Decision

[ENCODING_PREAMBLE](../../../../packages/shell/pwsh-local/src/index.ts) prefixes commands with `if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { … }` instead of running the two assignments unconditionally. `$ExecutionContext` is an engine intrinsic readable in every language mode, and ConstrainedLanguage enforces member writes at evaluation, so the skipped branch cannot throw. Control-flow blocks do not scope variables, so `$OutputEncoding` binds exactly as before, and the preamble still occupies line 1 so error line numbers stay accurate.

## Alternatives considered

**Set `__PSLockdownPolicy` or force FullLanguage in the runner.** The confined child's language mode is the sandbox's security decision; the executor must not widen it.

**Pin UTF-8 through a CLM-legal path.** `[System.Text.Encoding]::UTF8` static access and the property setter are equally denied, and `chcp 65001` cannot retarget a running process — no legal pin exists, so skipping is the only option.

## Consequences

pwsh 7 confined under ConstrainedLanguage keeps UTF-8 by default and produces clean stderr. Windows PowerShell 5.1 confined under CLM still cannot be pinned and emits the OEM codepage — a documented Known Limitation in the package README. A keyless spec enters ConstrainedLanguage on any platform and asserts the preamble emits nothing, so the unguarded form cannot regress silently. Host deployments built before this change can adopt it by string-replacing the single literal in `lib/index.js`.
