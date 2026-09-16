# Agent Note: Windows inspector frees its koffi allocations

Status: implemented

English | [中文](2026-09-16-windows-inspector-frees-koffi-allocations.zh.md)

## Problem

`windows-inspector.ts` allocated unmanaged memory through `koffi.alloc` — one `PROCESSENTRY32W` per process-table snapshot and four `FILETIME` values per `processState` call — and never freed any of it. `koffi.alloc` is a raw `calloc` whose return value is a bigint-wrapped pointer with no GC finalizer, so every call leaked: roughly 568 bytes per snapshot and 32 bytes per process-state read, on the ~25 ms teardown/wait polling path.

## Decision

Every `allocNative` allocation is now released with `koffi.free` in a `finally` covering all return and throw paths — one inner `finally` around the enumeration loop, one around the four `FILETIME` reads.

## Alternatives considered

**Keep stable buffers alive across calls.** Rejected: the inspector's per-call allocations are cheap, and caching native buffers adds ownership questions the call sites do not need.

**Suppress with a bounded pool.** Rejected: a pool still needs a release discipline and only defers the same fix.

## Consequences

Process inspection no longer grows unmanaged memory on Windows. `koffi.free` on the bigint wrapper is the documented release path for `koffi.alloc` pointers, so the pattern is safe to repeat if more native reads join the inspector.

## Verification

The Windows-only suite (`windows-inspector.spec.ts`, the `win32` block) exercises the real koffi bindings on the Windows CI lane; the allocation discipline is inside `try/finally`, so early returns and error paths free identically.
