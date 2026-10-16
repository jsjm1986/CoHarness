# Agent Note: Menu material surface and keyboard guards

Status: implemented

English | [中文](2026-10-15-menu-material-surface-and-keyboard-guards.zh.md)

## Problem

Menus rendered their chrome per call site: each floating list painted its own `background: var(--dsw-specific-menu)` plus its own radius, so translucency and corner shape could drift between the main menu, the input-trigger picker, the commands popup, the model selector, and the dock tab menu. Keyboard handling also predated the upstream alpha.2 hardening layer: an IME composition keystroke could drive row navigation, a menu buried under a modal still consumed Escape, and the floating position only refreshed on scroll/resize, so a dragged or transformed anchor left the list behind.

## Decision

`MenuSurface` in `ui-primitives` is the single menu material. It renders a translucent fill (`.material`, `backdrop-filter` + `--dsw-menu-surface-fill` light/dark values in `design-platform.css`) inside the surface and, on macOS, a body-portal backing anchored through a per-instance CSS anchor name so the native vibrancy layer has an element to attach to. Backing visibility mirrors the surface and the backing unmounts with it. The `--dsw-specific-menu` token now resolves to the shared fill, and menu-side `background`/`border-radius` rules were deleted so the material is painted exactly once.

The `Menu` primitive keeps its local contract — `header`, `footer`, `listStyle`, the mobile sheet backdrop, and the compact inline-submenu variant all stay because local packages (`ui-collaboration`, `ui-schedule`) consume them — and gains the rc2 behavior layer:

- `overlayTopMargin(MARGIN)` clamps the portal top edge below the desktop frame clearance.
- `observeComposition(document)` guards every keydown; `isBehindModal`, `defaultPrevented`, and Ctrl/Alt/Meta modifiers skip handling entirely.
- Escape runs on a capture-phase listener, passes `Shift+Escape` through, and ignores repeats; all other keys keep bubble phase.
- `requestAnimationFrame` tracking replaces pure event-driven placement so anchor movement under drag or transform stays aligned; `setFixedPos` skips identical writes.
- `autoFocus` opens via `focusWithoutRing`, matching the pointer-style silent focus; keyboard navigation still earns its ring.
- `selection: 'check' | 'fill'` picks the selected-row affordance; `fill` leaves highlighting to the row itself.

Four consumer surfaces — the input-trigger `MenuView`, the commands `PopupSelectView`, the model selector menu, and the dockkit `TabMenu` — render through `MenuSurface`, dropping their private background/radius rules.

## Alternatives considered

**Port the upstream Menu wholesale.** Rejected: upstream removed `header`/`footer`/`listStyle` and has no compact mobile submenu or sheet backdrop, while local packages consume all of them. The port keeps local API and behavior where upstream's product surface is narrower.

**Keep per-menu paint and only retarget tokens.** Rejected: the backing portal exists so macOS vibrancy can attach to a real element per menu — token retargeting alone would leave menus opaque on macOS and keep the double-paint risk wherever a consumer forgot to drop its own background.

**Listen for scroll/resize only.** Rejected: anchors move without firing either event (dragged windows, transformed ancestors); the rAF tracker costs one `getBoundingClientRect` pair per open frame and is deduped by the `setFixedPos` bail-out.

## Consequences

Every surface that adopts `MenuSurface` must stop painting its own menu background and radius, or the translucent fill double-paints — the four consumers were migrated together for that reason. The mobile inline-submenu override hides `[data-menu-material-fill]` inside `.submenu`, so any future material layer inside a submenu needs the same exemption. `--dsw-menu-surface-fill` is now the single menu fill; surfaces that still want an opaque panel must opt out explicitly.

## Verification

`menu-surface.client.spec.tsx` pins backing placement, independent anchors across two surfaces, backing removal on unmount, and visibility propagation. The ui-primitives / ui-dockkit / ui-input-trigger / ui-commands / ui-model-selection suites (74 files, 1549 tests) pass with the surface swap in place, and the host+client `tsc -b` faces compile clean.
