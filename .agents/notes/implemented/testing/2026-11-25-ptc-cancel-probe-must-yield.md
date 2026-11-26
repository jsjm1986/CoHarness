# Agent Note: Probe PTC cancellation readiness through a yielding write, not a fire-and-forget binding

Status: implemented

English | [中文](2026-11-25-ptc-cancel-probe-must-yield.zh.md)

## Problem

`packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts` — "cancels a live program and closes its managed process" — burned its full 180 s timeout on hosted Windows in both the `{}` variant (master run 45322944681) and the `{"timeoutMs":null}` variant (branch run 45481979435), while every neighboring teardown case in the same file finished in hundreds of milliseconds on the same runner. The program under test was `void tools.enter({}); for (;;) {}` with the host awaiting the binding's `entered` signal before aborting. The fire-and-forget invoke never reaches the host: the child's RPC write is queued inside libuv, and the synchronous hot loop starts before the event loop can flush it. POSIX libuv flushes small pipe writes inline, which is why the spec passes reliably on macOS and Linux; Windows overlapped pipe writes require a loop iteration, so whether `entered` fires at all is a coin flip per spawn. The test hung at `await entered.promise` — cancellation teardown was never even reached — and the inversion of which variant failed across runs confirms the race lives in the probe, not in process termination.

## Decision

Replace the readiness probe with the pattern already proven by the sibling "retains console output when a non-yielding program is canceled": the program writes a readiness file synchronously before entering the hot loop, and the host polls for the file before aborting. No binding round-trip participates in readiness, so no event-loop flush stands between program start and probe visibility. The canceled object is unchanged — a live hot-looping process killed mid-cancellation — and the abort result assertion is byte-identical. A comment at the probe records the yield requirement so the pattern is not simplified back into a fire-and-forget call.

## Alternatives considered

- **`await tools.enter({})` alone as the probe** — the await does yield and flush, but the host observes the invocation, not the program's resumption; an abort landing before the response returns cancels a suspended program instead of a hot-looping one, weakening the contract the test exists to pin.
- **Product-side flush guarantee for fire-and-forget invokes** — no such guarantee is implementable: a program that never yields cannot transmit, and this is intrinsic to cooperative scheduling rather than a PTC defect.
- **Treating the hang as a Windows Job runner termination defect** — ruled out by evidence: the `{}` variant passed in 612 ms inside the same run, `disposes active programs` (same teardown, awaited probe) passes on master in both variants, and the wedge paths of `WindowsJobOwner` produce fast failures rather than unbounded hangs.

## Consequences

The cancellation contract — an abort closes the managed process and returns the caller's reason — remains pinned against a genuinely hot-looping program on every platform. Any future probe that must observe a program past a point of no return needs the same property: evidence written synchronously before the blocking construct, never an in-flight RPC whose flush depends on the loop the program is about to strangle. Related: [windows teardown budget headroom](../bug-fix/2026-11-24-windows-teardown-budget-headroom.md) covers the independent taskkill-delivery budget class in the same lane.
