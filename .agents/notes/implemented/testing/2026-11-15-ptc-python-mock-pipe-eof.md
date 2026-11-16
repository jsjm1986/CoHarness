# Agent Note: controlled-subprocess fixtures must EOF pipes like a real exit

Status: implemented

English | [中文](2026-11-15-ptc-python-mock-pipe-eof.zh.md)

## Problem

`boot-write-failure.spec.ts` mocks `LocalSubprocessRuntime.spawnProcess` with `EventEmitter` children whose `stdin`/`stdout`/`stderr`/fd-3 are `PassThrough` streams. The runtime's run settlement (`finish()`) terminates the child, waits for exit, then drains `stdout`/`stderr` to their stream end under a `graceMs + CLOSE_REAP_MARGIN_MS` (5s) bound before resolving. The fixtures never ended those streams — no real close event was emulated — so every settling run waited out the full 5s drain bound, and each test landed a hair over Vitest's 5s `testTimeout`. Under any scheduler load the bound's timer fired after the test deadline: 12 of 20 tests failed with `Test timed out in 5000ms`.

## Decision

The mock ends all four pipe streams wherever the real kernel would deliver EOF: on the child's `close` and `error` events, and inside `terminate()` for the pid-less fakes (a terminated process closes its descriptors). `endPipes` guards destroyed/already-ended streams and swallows the fixture-injected `stdin.end` throw — a fixture whose write-end IS the injected failure must not turn teardown into a second failure. The suite went from ~64s with 12 load-dependent timeouts to ~3.4s deterministic.

## Consequences

Fixtures that fake process pipes own the pipe lifecycle: `close`/`error`/`terminate` must produce stream `end`, or the runtime under test legitimately waits its close bound and the test times out on a compliant implementation. The same `PassThrough` mock shape appears wherever subprocess pipes are controlled; authors adding such fixtures should end streams at the emulated exit point rather than relying on test-teardown destruction.

## Alternatives considered

- **Raising the suite timeout** — rejected: it hides the missing-EOF defect and still pays the full 5s drain bound per settling run.
- **Ending pipes only on `close`** — rejected: the pid-less fakes never emit `close`, so `terminate()` must close the streams it would have closed in the kernel.
