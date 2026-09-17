# Agent Note: Mobile composer keeps one icon-only toolbar row

Status: implemented

English | [中文](2026-09-18-composer-single-icon-row.zh.md)

## Problem

The phone composer rendered its controls on two lines by design: compact CSS moved the trailing group (model seat + context meter + send) into its own grid row whenever a model seat existed, and at ≤359px a separate session-summary strip replaced the seat entirely. The result was a permanently taller composer on every phone, the opposite of the single-line chrome the desktop card shows.

## Decision

Every compact control is an icon-only trigger on one toolbar line at every width. The model seat renders `IconBrainOutline16` alone, the permission seat renders its permission-specific shield glyph alone, and the context meter, attach, and send controls keep their existing glyphs. The `summary` presentation is removed from the input-control contract; a tap on any compact trigger opens the existing session-settings sheet where full labels live. Compact icon targets are 40px, stepping down to 36px below 360px so seven controls still fit a 320px card; the tools grid column clips before the row can wrap. Accessible names and titles still carry the full model/permission text, and nothing changes on non-compact tiers.

Related: [unified mobile session settings](../architecture/2026-08-24-unified-mobile-session-settings.md) (the sheet architecture this reverses on the toolbar side), [compact chrome density](../architecture/2026-08-19-compact-chrome-density.md).

## Alternatives considered

**Keep the labeled model chip and truncate harder.** Rejected: a readable model name plus reasoning effort plus shield label cannot share one line with attach, commands, meter, and send at 320–390px; truncation to a few characters identifies nothing.

**Move the trailing group out of the card.** Rejected: detaching send from the composer breaks the card's visual containment and duplicates chrome the hero already owns.

## Consequences

The compact composer never wraps the model/send group onto a second line, including inside narrow workbench panes where `data-viewport='compact'` applies. The input-control `presentation` union is now `'trigger' | 'section'`; slot occupants that handled `'summary'` must drop the branch. The 44px touch-target token no longer sizes compact composer controls, which follow the 40px/36px icon-target family instead.

## Testing

`composer-model-mobile.e2e.ts` measures the assembled card in a real browser at 390/375/320px and requires the model seat between tools and send on a single line inside the card; its committed golden records the new contract. Unit specs assert the compact triggers keep their accessible names, and the compact-chrome style spec asserts the wrap-forcing selectors are absent. Gaps: the icon-only affordance relies on the session sheet for identification, so first-run discoverability of model/permission seats is weaker than a labeled chip.
