# Agent Note: Mobile composer keeps one icon-only toolbar row

Status: implemented

English | [中文](2026-09-18-composer-single-icon-row.zh.md)

## Problem

The phone composer rendered its controls on two lines by design: compact CSS moved the trailing group (model seat + context meter + send) into its own grid row whenever a model seat existed, and at ≤359px a separate session-summary strip replaced the seat entirely. The result was a permanently taller composer on every phone, the opposite of the single-line chrome the desktop card shows.

## Decision

The compact toolbar uses icon-only controls. The model seat renders `IconBrainOutline16` and the permission seat renders its permission-specific glyph. Both expose accessible names and open the session settings sheet with full labels. The toolbar tightens gaps between 44px touch targets before moving the context meter and optional status trigger below the card. On touch-first devices, the Send and Stop face follows the toolbar width and has a lower cap in short landscape viewports.

Related: [unified mobile session settings](../architecture/2026-08-24-unified-mobile-session-settings.md) (the sheet architecture this reverses on the toolbar side), [compact chrome density](../architecture/2026-08-19-compact-chrome-density.md).

## Alternatives considered

**Keep the labeled model chip and truncate harder.** Rejected: a readable model name plus reasoning effort plus shield label cannot share one line with attach, commands, meter, and send at 320–390px; truncation to a few characters identifies nothing.

**Move the trailing group out of the card.** Rejected: detaching send from the composer breaks the card's visual containment and duplicates chrome the hero already owns.

## Consequences

The model and Send controls share the toolbar line at supported phone widths. The input-control `presentation` union is `'trigger' | 'section'`. Send and Stop resize inside the same 44px touch target, which keeps the tool gap and status placement calculations stable during a press or state change.

## Testing

`composer-model-mobile.e2e.ts` measures the model seat between the tools and Send at 390px, 375px, and 320px. `composer-status-layout.e2e.ts` measures the face and touch target in ordinary and maintenance conversations and checks the button edge remains reachable in the Stop state.
