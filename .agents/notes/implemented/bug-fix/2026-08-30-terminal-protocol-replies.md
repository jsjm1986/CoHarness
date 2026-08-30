# Agent Note: Drain terminal-protocol replies before PTY sends

Status: implemented

English | [中文](2026-08-30-terminal-protocol-replies.zh.md)

## Problem

Unix PowerShell uses terminal cursor-position queries during startup and while it owns the PTY. The persistent session previously treated those bytes as ordinary output, so a protocol reply could race the caller's input or readiness inspection. On macOS and Linux that race produced early `inferred_idle` results, incomplete startup output, and an occasional empty viewport.

## Decision

`dsh-terminal-bash` now feeds raw PTY output to a zero-scrollback `@xterm/headless` emulator dedicated to terminal-protocol state. Generated replies are serialized through the same terminal handle, raw chunks are coalesced while one parser write is active, and every send drains both parser and reply queues before writing caller input. Readiness re-inspects the foreground process after concurrent protocol activity, retains ownership until pending replies settle, and closes the emulator during transport failure or teardown. PowerShell startup uses one absolute `timeoutMs` deadline and accepts backend `stdin_read` evidence rather than echoed prompt source.

## Verification

The terminal-bash session suite covers split cursor queries, reply ordering, queue coalescing, parser and reply failures, timeout ownership, cancellation, teardown, and stale inspections. Index and real-shell suites cover the bounded PowerShell startup loop and existing bash behavior. The implementation keeps the existing sanitizer, output limits, sandbox policy, and process-inspector seam unchanged.

## Alternatives considered

**Parse cursor queries in the line sanitizer.** Rejected because readiness output and terminal control state have different ownership and buffering requirements.

**Write protocol replies immediately from each output callback.** Rejected because concurrent writes can overtake caller input and create one parser task per chunk under high output.

**Use a separate PTY backend for PowerShell.** Rejected because the protocol state, cancellation, limits, and teardown belong to the shared terminal session seam.

## Consequences

Unix PowerShell receives the protocol replies required by its interactive host, and caller input cannot overtake them. The emulator is an internal control-plane component; returned output remains bounded, sanitized, and line-oriented. Full-screen alternate-buffer interaction remains outside the backend contract.
