# Agent Note: Mobile typography and presenter baseline

Status: implemented

English | [中文](2026-08-24-mobile-typography-and-presenter-baseline.zh.md)

## Problem

Compact Web surfaces shared desktop density rules, so hierarchy-heavy pages reduced text and wrapped controls until they fit. The result kept actions reachable but made primary information difficult to read on 320px and short phone viewports.

## Decision

`ui-theme` owns compact typography roles, visual icon sizes, page insets, and section rhythm. Primary phone content uses the body role or larger; caption roles are reserved for metadata. A 44px touch target does not imply a 12px icon. Features whose information hierarchy changes materially on a phone use a mobile presenter or card/list projection while keeping the same slot, object-layer data, actions, and durable semantics. Desktop tables are not made mobile-readable by shrinking their rows.

Compact sheets use one opaque reading surface above one shared backdrop. Their summary content owns one scroll position, and short screens keep status/value rows in normal flow before lower-detail sections. Multi-action toolbars use explicit grid tracks at the narrowest step so secondary controls do not fall onto accidental rows.

## Alternatives considered

**Continue shrinking desktop typography and row density on phones.** Rejected because it preserves the desktop hierarchy at the cost of readable primary content, especially on 320px and short screens.

**Create separate mobile stores and slot paths.** Rejected because duplicated business state and actions would make mobile behavior diverge from the desktop projection and add another lifecycle owner.

**Let each feature define private mobile tokens and sheet geometry.** Rejected because repeated values would drift across plugins; `ui-theme` is the single owner of shared metrics while each feature retains its presentation choice.

## Consequences

New mobile UI consumes the `--dsw-mobile-*` roles and shared sheet metrics, declares its narrowest layout explicitly, and pairs a screenshot audit with behavior tests. A feature may change presentation hierarchy without creating a second business store or slot path. The compact visual audit covers 320×568, 375×667, and 390×844 in light and dark palettes.

## Verification

The responsive browser lane, focused GUI suites, `typecheck`, and client package/domain gates run after source and artifact builds. Screenshots are retained under `.playwright-mcp/compact-chrome/` for operator review rather than as a second product fixture.
