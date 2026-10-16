# Agent Note: Long-session input probe drops per-keypress driver roundtrips

Status: implemented

English | [中文](2026-10-16-long-session-input-probe.zh.md)

## Problem

The `input` budget in `benchmarks/long-session-browser/long-session.bench.ts` (reference 500 ms → CI budget 1250 ms) began failing intermittently with medians of 1285–1956 ms. The witness data the probe already captures (`data-benchmark-input-timing`) showed the trusted input event itself is processed within ~1–2 ms; the measured latency is the Playwright driver typing 23 characters through individual CDP `Input.dispatchKeyEvent` roundtrips — each ~50–80 ms on a shared runner while the main thread renders stream chunks — plus `expect.poll` and two `requestAnimationFrame` waits. That is wire cost of the measurement harness, not composer echo latency, and it scales with how busy the runner happens to be, which is why identical code passed at a 1231 ms median and failed at 1332 ms.

## Decision

The measured probe uses `page.keyboard.insertText(...)`, which delivers the same trusted `input` event carrying the whole probe string in one CDP call. The assertion surface is unchanged: `expect.poll` still verifies the React echo reaches `textContent`, `data-benchmark-input-overlap` still requires a trusted event arriving mid-stream, and `painted()` still waits for two rendering opportunities. What the budget now measures is event-to-echo latency during streaming — the user-visible quantity the budget exists to guard — with the per-keystroke dispatch amplification removed. The 500 ms reference is kept unchanged because the measured quantity is the same.

## Alternatives considered

- **Recalibrate `REFERENCE.input` upward** — widening the constant to match the inflated measurement would silence the flake while keeping a probe whose reading is dominated by driver wire cost and runner load; it would also erase the headroom the budget uses to flag real echo regressions.
- **In-page timing of event-to-echo via MutationObserver** — measures the same quantity with even less driver involvement, but requires new observation plumbing where `insertText` reuses the existing witness, poll, and paint assertions unchanged.
- **Larger sample count or retry on failure** — retries and more samples hide a measurement artifact behind longer runs instead of removing it.

## Consequences

- The budget regains real headroom: observed in-page echo during streaming is tens of milliseconds, so a future regression that starves input handling still fails well under 1250 ms.
- The probe no longer exercises per-character `keydown`/`keyup` dispatch during streaming; the unmeasured late-input probe retains `keyboard.type`/`press` coverage of that path.
- If a future change makes single-shot insertion meaningfully slower (e.g., an expensive synchronous `input` listener), the metric still catches it through `expect.poll` timing.
