# Agent Note: CoHarness brand identity in the web client

Status: implemented

English | [中文](2026-10-13-coharness-brand-identity.zh.md)

## Problem

The shipped client carried no unified product identity. Surfaces mixed `CoHarness`, `DSH`, and DeepSeek-era artwork across locale dictionaries, gate pages, the admin console, and the app icon; the turn-activity indicator was a generic shimmer over a localized sentence that said nothing about execution; and the brand accent rode `--dsw-alias-brand-primary`, which this theme maps to a neutral blue-gray ramp — so every mascot render in a React surface lost its blue lamp entirely.

## Decision

The product identity is a firefly mascot plus an uppercase letter-spaced `COHARNESS` wordmark on every product surface — hero, boot page, main and admin sidebars, scope-switch modal, and the four gateway façade pages. The standalone C mark remains only as the favicon/app icon, where the mascot is illegible at 16px. All accent color is solid `#2563eb` (light) / `#6b93ff` (dark) with no gradients.

`CoHarnessMascot` in `ui-primitives` is the only mascot React component. Its lamp, halo, and ember dots carry class `coh-mascot-accent`, painted by an inline `<style>` inside the SVG — `#2563eb` normally and `#6b93ff` under `body[data-ds-dark-theme]` — so the mark keeps its color on any surface without consulting theme tokens. A `busy` prop renders the working state: each wing rides a wrapper group holding the drawn tilt while a CSS rotation flaps it at its root, the body bobs, and the lamp breathes; `prefers-reduced-motion` freezes every animated part.

The chat `TurnStatus` replaces the shimmered sentence with the busy lockup — flapping mascot, a blue pulse cascading letter-by-letter across `COHARNESS`, three trailing dots — while the localized `chat.deepDiving` label moves to visually-hidden text so `role="status"` announcements keep working; the elapsed clock still appears past 15 seconds. The expanded sidebar centers the lockup over the row's content box (the collapse button is absolutely positioned so it does not skew the perceived center), and the admin sidebar integrates the bare mark with the wordmark — no containing tile — with cutouts painted in each host's surface color.

## Alternatives considered

**Drive accent color from `--dsw-alias-brand-primary`.** Rejected: the token resolves to a neutral blue-gray in this theme (near-black light, near-white dark), and relying on theme-token naming made the lamp lose its color on every React surface while the boot page — with its own `--dsh-boot-accent` — stayed correct. Carrying the color inside the component's `<style>` block removes the dependency entirely.

**Keep the shimmering localized sentence for turn activity.** Rejected: the effect is a generic loader look that carries no brand, and the requirement was to signal active execution, not idle loading. The localized text still exists — as the live-region label — so accessibility and the elapsed clock contract are unchanged.

**Gradient accents inside the mark.** Rejected by product direction: the identity is solid-color only; the one remaining gradient is the status wordmark's traveling highlight band, an effect layer on text rather than part of the logo artwork.

**A single shared mascot asset consumed by all surfaces.** Deferred: four independent representations exist — the React component, the boot page's inline SVG string, the gateway `html.ts` mark, and the admin-ui copy — and they already drifted once (the admin copy lost its halo circle until re-synced). Consolidation needs a shared asset pipeline and remains open.

**Center the sidebar lockup over the whole row.** Rejected: the absolutely-positioned collapse button sits inside the row, so whole-row centering leaves visibly more whitespace on the left; the lockup centers over the content box that reserves the button's width instead.

## Consequences

Each mascot copy outside `ui-primitives` is hand-synced and can drift silently — the admin copy already did. Every new accent-bearing surface must ship its own color rule; the component covers React consumers only. Each busy mascot instance inlines its own `<style>` block. Status tests assert brand markup (`data-brand`, wordmark letters) plus the hidden localized label rather than the old visible sentence.

Changing shared module exports (the icon renames in `ui-primitives` were the trigger) without rebuilding every consumer leaves stale chunks that crash slot entries at runtime — React error #130 inside a slot boundary removes the entry's chrome entirely. Release assembly must rebuild all consumers of a changed baseline, not only the changed package. The same build surfaced a rolldown gap: `implicitlyLoadedBefore` and `referencedFiles` are absent on chunks without such edges, so `web-product-bundle-isolation` treats both as optional.

## Verification

`ui-primitives` icon specs assert the accent style block and the busy wing/lamp classes; `ui-conversation` chat-view specs assert the live region keeps the localized label and clock while exposing the mascot and wordmark; `ui-sidebar` snapshots pin the non-busy markup unchanged. Real-browser checks rendered the built CSS and markup in light and dark themes, confirmed the accent values `#2563eb`/`#6b93ff`, and confirmed animation frames differ.
