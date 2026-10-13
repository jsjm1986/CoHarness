# Agent Note: Action controls keep one accessible name; live state rides in aria-description

Status: implemented

English | [中文](2026-10-12-stable-action-names-carry-state-in-aria-description.zh.md)

## Problem

The desktop-access confirmation trigger folded its current status into `aria-label`, so the control's accessible name changed with permission state — `Desktop access` while idle, `Desktop access · granted` after approval. Automation and assistive technology address controls by name; an exact-name lookup (`getByRole('button', { name: 'Desktop access' })`) matched only in the idle state and missed entirely once a status existed. The web verification suite caught this when its desktop-confirmation flow could no longer find the trigger.

## Decision

Action controls expose a name and a state as separate facts. `aria-label` names the action once and stays constant across every state the control can enter. Dynamic status text belongs in `aria-description`, which augments without renaming. Sighted users keep the combined `Name · status` presentation in `title`, where the pairing already lived.

This is the contract for every control whose label used to be assembled as `` `${action} · ${status}` ``: split the two halves, name first, description second. New status-bearing triggers follow the same rule from the start.

## Alternatives considered

**Keep the composite label and update callers to regex matching.** A name that mutates per state is still wrong for assistive technology — screen readers announce it as a different control — and regex lookups encode the composite format into every caller.

**Drop the status text.** The status is real information; removing it to stabilize the name trades accessibility for locator convenience.

## Consequences

`getByRole` name queries stay valid in every permission state, and screen readers announce one stable action plus a changing description. Any future control that derives its `aria-label` from live state repeats the bug; review for the composite-label pattern when a trigger's name lookup flakes between states.

## Verification

`apps/web/tests/desktop-confirmation.e2e.ts` finds the trigger by exact accessible name across the grant, save, and withdraw states that produced the miss.

## Related

[Shared motion scale and literal-glyph grammar](../feature/2026-10-12-shared-motion-scale-and-literal-glyph-grammar.md) governs the visual treatment of the same status indicators.
