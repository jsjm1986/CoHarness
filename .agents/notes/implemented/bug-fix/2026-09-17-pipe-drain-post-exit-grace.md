# Agent Note: Pipe drain is bounded after the child exits

Status: implemented

English | [中文](2026-09-17-pipe-drain-post-exit-grace.zh.md)

## Problem

`sandbox-windows-acl`'s `drainPipe` polled `PeekNamedPipe` until the write end reported a clean EOF (`ERROR_BROKEN_PIPE`/`ERROR_NO_DATA`). A descendant that inherited the pipe write handle and outlived the spawned child kept the pipe open, so the spawn's `wait()` — which awaits both drains before `waitForExit` — never returned. The kill-on-close job does not help: it terminates members only when its handle closes, which happens after the wait.

## Decision

`drainPipe` takes the child process handle and polls it with a zero-timeout `WaitForSingleObject` each iteration — a non-consuming liveness read, since `waitForExit` still owns the handle. Once the child has exited, the EOF wait is bounded by `PIPE_DRAIN_POST_EXIT_GRACE_MS` (2 s); when the grace expires the drain closes its read end and returns the collected prefix. EOF still wins whenever it arrives — the bound only covers its absence.

## Alternatives considered

**Truncate at child exit.** Rejected: a well-behaved child flushes its final bytes just before exit; cutting the drain at the exit edge can lose buffered output the pipe still holds.

**Kill the job when EOF stalls.** Rejected: the job's kill-on-close is the orphan backstop, not an output deadline; killing descendants to force EOF changes what the spawn ran.

**Document the hang as a limitation.** Rejected: a sandboxed child spawning a lingering grandchild is ordinary behavior, and an unbounded `wait()` turns it into a caller-visible hang.

## Consequences

`wait()` always settles: output ends at clean EOF, at process teardown, or at the post-exit grace — whichever comes first. A lingering descendant can truncate the tail of captured output by at most its own post-exit lifetime plus two seconds.

## Verification

`failure-paths.spec.ts` drives `drainPipe` with a stubbed binding table whose pipe never reports EOF while the process polls as exited; the drain resolves with the collected prefix and still closes the read handle.
