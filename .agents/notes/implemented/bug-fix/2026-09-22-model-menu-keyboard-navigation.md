# Agent Note: Keep keyboard focus inside model-menu navigation

Status: implemented

English | [中文](2026-09-22-model-menu-keyboard-navigation.zh.md)

## Problem

A two-level model menu removes the focused row when its pane changes. Without an explicit destination, focus falls onto the page and the next key cannot reach the menu. An inline popup can also be clipped by a narrow conversation column even when its trigger remains visible.

## Decision

The desktop model control uses the upstream menu's keyboard rules and body portal. Arrow keys enter at the near end and wrap; entering a model or effort pane focuses its current value, then an available row or the trigger. Tab activates a row, while Shift+Tab and Escape return to the parent pane and then the trigger. Retry controls keep native Tab traversal. Outside-pointer and blur checks recognize both the trigger subtree and the portaled menu. Locking or withdrawing the control closes its disclosure, so recovery cannot resurrect an old menu.

The popup aligns above the trigger's right edge and is clamped to the viewport on scroll, resize, pane changes, and catalog updates. Only mounted rows participate in focus selection; the shared mobile section can construct the same options without mounting their popup variants.

Compact composers retain the Session Settings sheet and its focus ownership. Standalone phone compositions retain their inline sheet; container-driven glyph sizing and touch targets are unchanged. The [model directory decision](../feature/2026-07-24-web-session-model-selector.md) retains selection ownership and the [mobile seat decision](2026-08-17-composer-mobile-model-seat.md) retains width constraints. Input-capability labels, governance refusals, and Session-targeted RPCs remain on the existing directory path.

## Verification

Component regressions cover keyboard entry, wrapping, selection, pane return, empty catalogs, Retry traversal, portal bounds, and lock/recovery. The [assembled composer scenario](../../../../apps/web/tests/composer-model-mobile.e2e.ts) selects effort through real keyboard events on desktop and retains the existing phone geometry snapshot.

## Alternatives considered

**Focus the first row after every render.** Catalog refreshes would steal focus from the user's current position. Only a pane-navigation intent moves focus.

**Replace the phone sheet with the desktop popup.** The phone's shared Model, Reasoning, and Permission navigation already owns that interaction. Replacing it would discard a working local consumer.

**Change the model transport while porting its control.** Selection, authorization, and error formatting are independent of popup navigation and remain authoritative in the shared directory.

## Consequences

Pointer and keyboard users traverse the same model and effort choices without losing focus or access to the menu. The desktop popup escapes conversation-column clipping while mobile layout and model-governance behavior remain intact.
