# Agent Note: Settings overlay portal and compact full-screen page

Status: implemented

English | [中文](2026-08-19-settings-overlay-portal.zh.md)

## Problem

On compact viewports the settings overlay is a `position: fixed` descendant of the sidebar drawer. The drawer uses `transform` and `overflow: hidden` at `min(85%, 320px)`, so the overlay's containing block is the drawer rather than the viewport. Combined with a column flex panel whose content row lacks `min-height: 0`, the models list is clipped and `.options { overflow-y: auto }` never receives a bounded height. Phone users cannot scroll to the last organization model. The desktop 800px two-column sheet is otherwise squeezed into that drawer: 36px tabs, 28px close, and nowrap model rows.

## Decision

`SettingsPanel` portals to `document.body` and holds `#root` inert for its lifetime, restoring the previous inert flag on close (OnboardingSurface / Modal precedent). Compact (max-width 767px, a media query because the overlay never sees `data-viewport`) is a full-viewport page sized with `--dsw-viewport-height` / `100dvh` and `--dsw-safe-*`. A CSS grid plus `display: contents` on `.nav` / `.content` keeps the title and close on the first row, the section tabs on the second, and `.options` as the only scrolling region. Tab cells and the coarse-pointer close control use `--dsw-touch-target`. Desktop remains the 800px two-column card. Section packages own their compact stacking (models name/id, general rows, plugin tabs, inventory search, preset cards); they do not import the shell.

Related: [responsive shell viewport modes](2026-08-14-responsive-shell-viewport-modes.md).

## Alternatives considered

**Only add `min-height: 0` / `overflow-y: auto` on `.options`.** Rejected: the overlay would still be the drawer — at most 320px wide with the conversation visible beside it.

**Reuse the primitives `Modal` bottom sheet.** Rejected: Modal is a short dialog (document manager). Settings is a long destination; a sheet still clips a long organization catalog. Modal's compact geometry stays a bottom sheet.

**iOS-style drill-in (section list, then a pushed page).** Rejected for this change: three or four sections fit a horizontal tab strip without a second navigation level.

**Close the compact drawer when settings opens.** Rejected: the user opened settings from the sidebar and should return to it. The portaled overlay covers the viewport without coupling Settings to AppFrame.

## Consequences

Compact settings fills the visual viewport and scrolls inside `.options`. Theme cubes stay on one row; the four section tabs fit the 390px strip without clipping (the tab row sets `overflow-y: hidden` because `overflow-x: auto` would otherwise compute a second vertical scroller). Nested delete/catalog dialogs already portal through Modal and stack above. A compact drawer `transform` no longer clips this overlay. `ui-settings-general` peers `react-dom` for `createPortal`. Display-contents chrome can flatten the compact accessibility tree relative to desktop; the compact e2e goldens pin that tree.
