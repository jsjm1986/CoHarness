# Agent Note: Replay `hold` gates a scripted stream at a chosen chunk

Status: implemented

English | [中文](2026-10-17-replay-hold-chunk-gate.zh.md)

## Problem

Browser scroll-contract tests that assert while a model stream is in flight need the stream to still be in flight when the assertion runs, but a replayed script is finite: the `chat-scroll-contract` anchor and fling cases each streamed a fixed number of paced text deltas, then counted the chunks arriving after a scroll-driven anchor capture. On a contended runner the wheel, fling, and repaint steps outlasted the script, the count froze at its total, and the assertion `received > captured + 5` could never succeed — `124 > 129` and `249 > 250` failed in the master browser sweep on run 38952571005 even though the product behaved correctly, and the anchor case had already failed twice on earlier master runs with the same exhausted-total signature. Making the recorded script longer shrinks the window without closing it: any finite stream still loses to a slow enough machine.

## Decision

A `chunks` replay entry may carry `hold: { after, releaseFile }` (`ReplayHold` in `dsh-llm-replay`). The generator yields `after` chunks, then polls `existsSync(releaseFile)` before yielding the rest; the scenario owns the file and creates it at the moment it wants the tail to flow. A relative `releaseFile` resolves against the override file's directory so the marker sits inside the scenario's own `mkdtemp` replay directory and is removed with it, `after` must be below the chunk count (a gate that can never engage fails loud at load), and the wait carries the same abort contract as `paceDelay` so a cancelled request never parks.

The anchor test holds 24 chunks before the end of its stream and releases them immediately after capturing the reader anchor, so the "still streaming" precondition is a state the test creates rather than a race it wins. The fling test holds 44 chunks, releases the tool gate, scrolls away and back while the stream is parked, and releases the tail only after the repin settles, so bottom-follow provably owns live chunks arriving at the floor. `markdown-inline-code-links` wraps popup navigation inside the existing bounded shift+click retry instead of only the popup-creation event: the chromium-1234 defect the comment cites drops the default action in either position, and a popup that never leaves `about:blank` now costs one gesture attempt rather than the whole case. This follows the same rule as [observations wait on the state they read](2026-09-27-observation-waits-on-observed-state.md): the wait is bound to the state being asserted, not to a wall-clock window.

## Alternatives considered

- **Longer or slower recorded streams** — any finite script still exhausts under enough contention, so the precondition remains probabilistic; the gate makes "the stream is still running" a fact the test controls.
- **A `hang`-style terminal entry between the prefix and tail** — `hang` exists only as a whole entry awaiting cancellation, and ending the stream would change the turn's settlement; the assertion needs one continuous stream that resumes, not two calls or an aborted one.
- **Polling `assistantFrames` for liveness before asserting** — re-checking that the stream has not finished right before counting narrows the race to the observation-to-assertion gap but cannot eliminate it, and a run that lost the race still produces a wrong failure.
- **Waiting on DOM readiness instead of the stream** — the rows the tests need are the in-flight chunks themselves; only holding the producer guarantees they exist.
- **Retrying or widening `waitForURL` for the popup** — the awaited state is already identified; the failure mode is that the upstream gesture is dropped, which only a fresh gesture can fix, so the retry bounds the known transient rather than masking the wait.

## Consequences

The two scroll cases and the popup case no longer depend on machine speed for their preconditions; failures they still report name real regressions. Every scenario that needs an in-flight stream at a chosen moment can use the same entry field instead of inventing pacing budgets. What was given up: nothing user-visible — the field is optional, existing entries are unchanged, and the released session format is untouched because `hold` lives only in the override sidecar.
