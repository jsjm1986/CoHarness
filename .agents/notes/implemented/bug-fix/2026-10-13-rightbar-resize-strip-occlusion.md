# Agent Note: Details resize strip rides the panel border, above dock and scrim layers

Status: implemented

English | [中文](2026-10-13-rightbar-resize-strip-occlusion.zh.md)

## Problem

The inset-card restyle (`b8b1715df87`) gave `.detailsCol` an 8px frame inset (`right: var(--dsw-space-2)`), moving the docked right panel's left border one inset left of the track edge the resize handle centers on. The 8px strip therefore sat entirely inside the panel box, where dockkit cells (`z-index: 10`, `pointer-events: auto` on `.tabHost`) painted and hit-tested above the handle (`z-index: 2`) — every pointerdown landed on panel content and no drag ever started, and the hover-reveal pill rendered under the panel's opaque background. The same arithmetic left the medium-width overlay panel under its own scrim (`z-index: 14` vs the dock layer's 10): the open overlay was dimmed and every click dismissed it. jsdom suites dispatch pointer events straight at the handle element, so neither regression was observable in unit tests.

## Decision

The strip now centers on the seam the user actually sees and grabs — the panel's left border — instead of the track edge. `.handle[data-side='details']` translates `calc(0px - var(--dsw-space-2)) 0` in non-compact modes, mirroring the `.detailsCol` inset token so the offset cannot drift. `.handle` rises to `z-index: 15`, above the dock layer (10) and the open scrim (14), while portalled overlays (20) and dockkit floats (60) stay above it; the pill therefore paints on the card edge. `.frame[data-viewport='medium'] .detailsCol` gains `z-index: 15`, lifting the whole overlay panel subtree above its scrim; compact needs no lift because fullscreen presentation already raises the dock layer to 40.

## Verification

`app-frame-styles.client.spec.ts` asserts the contracts lexically: the details-strip translate mirrors the inset token, the handle's z-index (15) sits above the scrim's (14), and the medium `detailsCol` lift exists. A Chromium hit-test on the compiled stylesheet (extracted from the built `client.js`, real `elementFromPoint`) showed the pre-fix strip region resolving to `.tabHost` in expanded mode and to the scrim everywhere in medium, and post-fix resolving to the handle at the panel border, panel content inside the panel, and the scrim only on background — with the hover pill revealed.

## Alternatives considered

**Move the strip into the gutter between the cards.** Rejected: it would leave the panel untouched and need no z-index change, but the affordance would float between the cards instead of straddling the border the user expects to grab.

**Compute the offset in `AppFrame.tsx`.** Rejected: it would hardcode a pixel inset in JS while the inset lives in the stylesheet as a token; the CSS `translate` keeps a single source of truth.

## Consequences

- The details resize affordance is hittable and visible again in expanded/wide modes, and the medium overlay panel is interactive above its own scrim.
- `left` in `DragHandle` props is still the track edge; the panel-border correction is stylesheet-owned and keyed on `data-side='details'`.
- Any future inset change to `.detailsCol` automatically moves the strip with it; changing the scrim or dock layer numbers must keep `14 < handle < 20`.
