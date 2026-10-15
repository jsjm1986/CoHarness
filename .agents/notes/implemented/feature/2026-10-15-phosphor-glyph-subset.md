# Agent Note: Back ten ic_ds_* glyphs with inlined Phosphor path data

Status: implemented

English | [中文](2026-10-15-phosphor-glyph-subset.zh.md)

## Problem

The icon catalog was uniformly Lucide-backed, but a row-by-row comparison against the Phosphor set used by the reference design system showed ten glyphs where Phosphor carries the better metaphor or reads cleaner at 16px: the sidebar collapse toggle (`sidebar`), the skills glyph (`squares-four` vs the interlocking `blocks`), the share action (`export` vs the network-node `share`), the workspace tree (`tree-structure` vs `folder-tree`), the loading arc (`spinner-gap`), the pane expand/minimize pair (`arrows-out` / `arrows-in` / `corners-out`), the members group (`users-three`), and the calendar (`calendar` duotone).

## Decision

`packages/client/ui-primitives/src/icons/index.tsx` gained a `ph()` factory that renders inlined Phosphor path data on the 256 grid with `fill="currentColor"`, keeping the existing `IconProps` contract (`size`, `className`, svg passthrough) identical to `glyph()` exports. Duotone selections pass a `[secondary, primary]` path tuple; the secondary layer renders first at 45% opacity per the reference dual-layer treatment. No new dependency: the ten path strings live in a `PH` constant so the icon module stays self-contained and auditable.

The Lucide imports that no longer have a consumer were removed in the same change; every export name and drawn size is unchanged, so consumers and golden a11y listings (`img` role on bare svgs) are unaffected.

## Alternatives considered

**Depend on `@phosphor-icons/react`.** Rejected: adding a second icon library to ship ten glyphs duplicates the static bundle's icon machinery, and the duotone sublayer opacity is a fixed 20% upstream while the adopted treatment uses 45%.

**Migrate the whole set to Phosphor.** Rejected: Lucide is stroke-based and Phosphor is silhouette-based; mixing them wholesale creates a style clash. The replacements are limited to rows where the shape reads strictly better.

**Keep Lucide and only add a secondary layer.** Rejected for these rows: a 45% sublayer over a stroke outline produces muddier silhouettes than a native duotone drawing.

## Consequences

New glyph swaps follow the same pattern: extract the path data, add a `PH` entry, and rebind the export — no consumer edits. The catalog-count test in `tests/icons.client.spec.tsx` still guards the export surface, and the currentColor/no-palette assertion covers the inlined paths.
