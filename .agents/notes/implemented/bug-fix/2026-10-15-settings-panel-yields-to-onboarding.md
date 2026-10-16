# Agent Note: Settings panel closes when an onboarding step appears

Status: implemented

English | [中文](2026-10-15-settings-panel-yields-to-onboarding.zh.md)

## Problem

An onboarding step owns the viewport behind an overlay that marks only `#root` inert. The settings panel portals beside `#root`, outside that mark, so a step that appeared while the panel was open left the dialog focusable and clickable behind the onboarding mask — two competing modal surfaces on screen. The upstream fix is the settings face of `7dfad907488` (its window-drag faces target the desktop drag-region platform, which this fork does not carry; the dockkit float drag-claim withdrawal was already present locally).

## Decision

`SettingsRoot` watches the resolved `onboardingStep`: when a step appears while the panel is open, the panel closes through the same `actions.close()` path as the mask and Escape. The watcher compares against a ref of the previously seen step, so only a transition from no-step to step dismisses the panel; a step already visible when the panel opens is not a dismissal trigger.

## Alternatives considered

**Portal the panel under `#root` instead.** The step's `inert` mark would then cover the panel, but the panel would still paint and announce as an open dialog beneath the overlay — closing is the honest state.

**Give the onboarding overlay a higher stacking claim.** That hides the symptom, not the state: the panel store would still report `open`, its trigger would still advertise an expanded dialog, and Escape routing would remain ambiguous between two modal layers.

## Consequences

The panel never shares the screen with an onboarding step; its open state, trigger `aria-expanded`, and document listeners stay consistent because dismissal goes through the normal close action. Re-opening during onboarding remains possible — the effect dismisses only on the appear edge — matching upstream.

## Verification

`settings-root.client.spec.tsx` mounts with an active session (no step), opens the panel, then turns the session blank so a step appears; the dialog is gone. The existing mask/Escape close-path cases keep passing, covering the shared `actions.close()` path.

## Related

- [2026-10-15 composer-stack tooltip portals](2026-10-15-composer-stack-tooltip-portals.md) — the adjacent overlay/portalling fix from the same client alignment pass.
