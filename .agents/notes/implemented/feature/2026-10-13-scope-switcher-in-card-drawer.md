# Agent Note: Scope switcher opens as an in-card drawer with identity tiles

Status: implemented

English | [中文](2026-10-13-scope-switcher-in-card-drawer.zh.md)

## Problem

The project/space switcher presented its list as a floating overlay card launched from the sidebar foot. The detached surface read as a separate widget rather than part of the sidebar card, and each row carried a generic dot — with many spaces the list offered no identity scanning and no fast way to tell personal, steward, and ordinary project scopes apart.

## Decision

The wide sidebar path keeps `Menu` as the behavior owner — selection, keyboard navigation, search, management entries, and close handling are unchanged — but renders it with `portal={false}` so the list sits in normal flow inside the foot. `.scopeSheet` (doubled to `.scopeSheet.scopeSheet` so the override survives module concatenation order against `Menu`'s `.root`/`.list`) applies `position: static` and `order: -1`, placing the sheet directly above the trigger row as a drawer; `.regionArea` shrinks and clips via its existing `overflow: hidden`. The sheet renders transparent on the footer column (no fill, shadow, or radius of its own) and is capped at `min(560px, calc(100vh - 150px))` so the trigger below stays reachable on short windows; its header region hosts the persistent space hub described by [the sidebar-takeover note](2026-10-13-scope-hub-sidebar-takeover.md). The collapsed rail path is unchanged and still renders a portalled floating menu.

Rows gain a 20px identity tile in place of the dot: ordinary projects show the name's first Unicode code point (`Array.from`, so surrogate pairs stay whole) on a deterministic solid tone picked by summing the name's code points across blue/green/amber/red/deep fills; personal scope shows a circular blue user tile; steward projects show an amber shield tile. Mode badges (read-only/read-write, steward) remain fixed trailing text. The trigger itself wears the current scope's tile, and its chevron rotates 180deg while `aria-expanded` is true.

Related: [sidebar footer stacked rows](../architecture/2026-08-19-sidebar-footer-stacked-rows.md) — the drawer extends the same stacked foot; row geometry is unchanged. The sheet's skin and pinned content are superseded by [the space-hub takeover](2026-10-13-scope-hub-sidebar-takeover.md).

## Alternatives considered

**Keep the floating menu and restyle its surface.** Rejected: a detached overlay still floats over the card it belongs to, which is the visual disconnect being removed.

**Command-palette switcher (auto-focused search with a key-hint bar).** Rejected: it abandons the `menu`/`menuitem` roles and folds management affordances into a filter row, and the gain matters only at a scale the list already serves through search.

**Hand-built row list instead of `Menu`.** Rejected: it would fork selection, keyboard, and close semantics for a skin change.

## Consequences

- The drawer is in-card geometry: opening it reflows the foot and clips the session region rather than overlaying it, and nothing portalled needs repositioning when the sidebar width changes.
- `.scopeField`/`.scopeSheet` carry doubled selectors; keep them doubled if either rule is edited.
- The rail trigger keeps the circular compact geometry and the floating menu; wide and rail no longer share the list surface.

## Testing

`components.client.spec.tsx` asserts the letter tile (「支」 for 支付重构), the steward shield tile, and that selection still routes through `onSelect`. `scope-control-styles.client.spec.ts` pins the in-flow contract lexically — `order: -1`, `position: static`, the transparent surface, the height cap — plus the tile metrics and tone classes. Focused suites pass and `tsc -b packages/client/ui-collaboration/tsconfig.json` is clean. A Chromium mock built from the real `Menu`/`MenuSurface`/theme stylesheets measured the sheet in flow above the trigger.
