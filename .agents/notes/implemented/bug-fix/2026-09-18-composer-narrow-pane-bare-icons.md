# Agent Note: Narrow-pane composer uses bare icon seats with hover discs

Status: implemented

English | [中文](2026-09-18-composer-narrow-pane-bare-icons.zh.md)

## Problem

At the 480px container step the composer collapsed its permission and model chips to icon-plus-chevron seats, while attach, document, and command seats kept their filled discs. Inside a workbench pane at its ~360px minimum the row still overflowed, and the always-filled discs spent visual weight a narrow pane does not have.

## Decision

The composer `.row` is `nowrap` outright: nothing can take a second line at any width, so degradation proceeds continuously instead. Both row groups participate in that shrink — `.tools` and `.trailing` are `flex: 0 1 auto` — because a rigid group holds its max-content width and the overflowing right edge pushes Send outside the card. Chip labels truncate fluidly (flex `min-width: 0` + ellipsis), contributed extension items clip inside their own lane, and under `@container (max-width: 480px)` — the shared narrow-panel step — every composer control degrades to a 28px bare seat: the permission and model triggers drop their label and chevron for the glyph alone, and the attach/document/command seats go transparent. Hover paints a 24px disc behind the glyph — the `triggerGlyph` circle on the chips, an inset `::before` on `.add` — so the resting row stays flat and the affordance appears only under the pointer. Below 340px the context meter hides outright, because its detail already lives in its popover and the composer footer stats, rather than competing for a row it cannot share. The compact phone tier is unchanged: `[data-viewport='compact']` restores the filled 40px seats (36px below 360px), keeps the meter visible, and clears the hover pseudo-element so a sticky touch hover cannot repaint the disc.

## Alternatives considered

**Keep the chevron beside the collapsed icon.** Rejected: the chevron costs ~12px per chip and reads as a second glyph at this density; the trigger still opens its menu or sheet, and `title`/`aria-label` carry the full identity.

**Wrap the overflow onto a second row.** Rejected for the same reason the container-degradation note rejected two fixed rows: a narrow pane pays vertical space whenever it narrows, while hiding the meter costs nothing because its data lives elsewhere on the card.

**Apply the bare 28px seats on compact phones too.** Rejected: touch targets stay in the 40px/36px family on compact; the bare tier exists only where a pointer does the aiming.

## Consequences

The composer holds one line at the workbench pane minimum and degrades further only by hiding the meter under 340px of container width. Both chip triggers keep their accessible names, titles, menus, and settings-sheet entry; the meter's popover remains reachable wherever the meter itself still renders. This refines the seat treatment in [composer row degrades by container width](2026-09-17-composer-row-container-degradation.md) — same anonymous container and shared step — and leaves the compact tier that [mobile composer keeps one icon-only toolbar row](2026-09-18-composer-single-icon-row.md) owns untouched.

## Verification

`model-select-styles` and `compact-chrome-styles` pin the 28px seat, the 24px hover disc, the removed chevron, the shrinkable row groups, and the compact restores against the stylesheet text; the same spec asserts the meter's 340px container hide and its compact exemption. Browser-checked on the built app: a 360px workbench pane shows a single 28px-high row with bare icon seats and no meter, an 800px pane keeps labeled chips, and hover computes the inset disc. Sweeping a pane through the 480–560px container band keeps Send inside the card while the model name contracts; the same band with rigid groups reproduced the overflow that motivated them. `composer-model-mobile.e2e.ts` passes unchanged on the compact tier.
