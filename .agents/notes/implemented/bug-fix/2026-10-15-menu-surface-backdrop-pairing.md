# Agent Note: Elevated menu surfaces pair fill with backdrop-filter

Status: implemented

English | [中文](2026-10-15-menu-surface-backdrop-pairing.zh.md)

## Problem

`--dsw-specific-menu` resolves to the shared translucent fill (58% opaque light, 45% dark) that [the menu material surface](../feature/2026-10-15-menu-material-surface-and-keyboard-guards.md) paints together with `backdrop-filter: var(--dsw-menu-backdrop-filter)` — the blur(40px) + saturate(150%) half is what turns see-through text into frosted depth. Four bespoke floating surfaces adopted the fill token but never the backdrop, so conversation text bled through them at 42–55% visibility: the subagent lineage menu, the jobs list menu, the turn stats dialog, and the message-feedback note panel. Each is a `position: fixed` portal above session content — the worst possible backing — and each reproduced as overlapping illegible text layers.

## Decision

Each affected surface gained the one missing declaration, `backdrop-filter: var(--dsw-menu-backdrop-filter)`, alongside its `background: var(--dsw-specific-menu)`. These surfaces paint their own chrome rather than rendering through `MenuSurface` — the lineage menu is a disclosure tree with its own row/children grammar, the stats dialog and note panel are content panels, the jobs menu carries live row chrome — so the fix is the declaration pairing, not a migration to the shared material. Badge-sized elements inside the jobs menu reuse the fill as a colour on purpose and were left alone.

A new repository gate, `verify-menu-surface-backdrop`, enforces the pairing for every future surface: within any stylesheet rule under `packages/client`, `background: var(--dsw-specific-menu)` or `var(--dsw-menu-surface-fill)` combined with an elevation shadow (`box-shadow: var(--dsw-elevation-*)` or `--dsw-elevation-stroke-color`) requires `backdrop-filter` in the same block. Fill without elevation — the badge exemption — is permitted. The gate runs in `consumerSurfaceGates` beside the other client surface checks.

## Alternatives considered

**Migrate the four surfaces to `MenuSurface`.** Rejected for this fix: three of the four are not menus at all (a disclosure tree, a stats dialog, a note editor), and the jobs menu's live-row chrome predates the material contract. The pairing declaration restores readability without rearchitecting row content; a material migration remains possible per surface.

**Opaque fills instead.** Rejected: it would fork the surface language — five other floating surfaces keep the frosted recipe, so translucency is the system, not the defect.

## Consequences

- Any new floating surface that wants the menu fill must declare `backdrop-filter` in the same rule or the gate fails; opaque panels that avoid `--dsw-specific-menu` entirely are unaffected.
- The pairing is a recipe contract, not a token contract — the theme keeps both halves separate so surfaces may still opt out by choosing a different fill.

## Testing

`scripts/verify-menu-surface-backdrop.spec.ts` asserts the repository inventory is clean, rejects a fixture missing the backdrop on both fill spellings, and exempts a fill-carrying element without elevation. The gate reports zero violations across the client corpus after the fix.
