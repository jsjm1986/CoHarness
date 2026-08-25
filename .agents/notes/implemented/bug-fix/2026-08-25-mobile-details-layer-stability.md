# Agent Note: Compact detail sheets keep semantic headers and cover the composer

Status: implemented

English | [中文](2026-08-25-mobile-details-layer-stability.zh.md)

## Problem

Compact trajectory rows use a narrow icon rail, but the same kind badge is also rendered in the event-details header. Applying the row width to the header can paint a long `ASSISTANT` label outside the sheet and the viewport. The animated compact mask can also leave the fixed composer visible during the first frame of a details-sheet opening.

## Decision

Selectors that collapse kind labels and icons are scoped to ledger rows. The detail header keeps a shrinkable title group, an ellipsizing location, and an intrinsically sized semantic kind label. A details-open marker identifies the active trajectory takeover for the conversation and trajectory stacking rules. Compact masks paint immediately; the details sheet retains its vertical entrance motion with an opaque first frame.

## Alternatives considered

**Allow the header to inherit the compact row badge width.** Rejected because the header is a reading surface, not an event rail, and long semantic labels would remain clipped at narrow widths.

**Portal every trajectory details sheet to `document.body`.** Rejected because the existing session-scoped selection, focus restoration, and scroll ownership can remain local; explicit stacking state fixes the ownership issue without duplicating the presenter path.

**Remove all compact sheet motion.** Rejected because the sheet can retain its vertical motion without exposing the composer; only the mask opacity transition is removed from the first-paint path.

## Consequences

Assistant, system, and other detail headers remain inside the viewport at compact widths while ledger rows retain their low-cost icon projection. The composer is covered as soon as a details sheet mounts, including on slower mobile WebViews. Compact masks no longer fade in, but their blur and color treatment remain unchanged; sheet motion remains available unless reduced motion is requested.

## Testing

The compact stylesheet, trajectory table/view, conversation chrome, and primitive compact suites pass together with 75 tests. The assembled browser visual audit exercises 390×844, 375×667, and 320×568 real Chromium pages, checks the assistant header bounds, and samples the composer hit target before and after sheet motion. Client build and typecheck pass.
