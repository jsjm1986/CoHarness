# Agent Note: Stable aria captures wait for an idle model trigger

Status: implemented

English | [中文](2026-10-11-stable-aria-waits-for-idle-model-trigger.zh.md)

## Problem

`captureStableAria` judged a region settled when two consecutive normalized aria snapshots were equal. The model trigger's loading state presents a steady "Loading model…" label, and `aria-busy` does not appear in the aria snapshot, so a region captured while the directory was still loading passed the equality check — the golden expects the settled model name, and CI failed nondeterministically (`markdown-images.e2e.ts` showed `Loading model…` where `DeepSeek-V4-Flash` was expected). About forty goldens capture the trigger, so per-spec waits would each repeat the same hazard.

## Decision

The trigger button reports its loading state as `aria-busy` — the same expression its menu already used (`state.status === 'loading' || busy`) — and `captureStableAria` requires every stability round to find no `[data-model-trigger][aria-busy="true"]` inside the captured region before accepting equality.

## Alternatives considered

**Wait once before the stability poll.** Rejected: the trigger can mount after the wait and sit in loading across both captures, leaving the residual window that produced the flake.

**Match the localized placeholder text.** Rejected: the label changes with locale and hardcodes a UI string inside shared capture infrastructure.

**Refuse while any `aria-busy` exists in the region.** Rejected: persistent busy elements (e.g. `role="status"` panels marked busy by design) can legitimately appear in goldens and would stall their specs.

**Keep per-spec `waitFor` calls.** Rejected: forty-odd goldens capture the same trigger; the shared helper is the one home for the settle condition.

## Consequences

A capture taken while the model directory is loading waits up to ten seconds; a genuinely stuck load surfaces as `aria snapshot did not stabilize`, naming the awaited state instead of writing a nondeterministic diff. The trigger's `aria-busy` now also reports loading for assistive technology, matching the menu.

## Verification

`model-select.client.spec.tsx` asserts `aria-busy` on the loading trigger. `markdown-images`, `math-rendering`, `reference-composer`, and `workspace-history-entry` e2e specs — each holding a golden that names the settled model — pass against the built web app with the stricter settle condition.

## Related

- [Floor geometry owns at-bottom](2026-09-16-floor-geometry-owns-at-bottom.md) — records why waiting for a settled state is the wrong fix when the captured state is permanent; here the loading state is transient.
