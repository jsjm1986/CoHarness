# Agent Note: Composer row degrades by container width

Status: implemented

English | [中文](2026-09-17-composer-row-container-degradation.zh.md)

## Problem

The composer toolbar holds eight controls (attach, documents, commands, permission chip, preset slot, model trigger, context meter, send). Its only narrow-width answers were viewport-driven: below 768px the compact stamp wraps the trailing group to a second line, and below 360px the chips unmount into the settings-sheet summary. A narrow composer inside a wide window — a workbench conversation column, a squeezed panel — matched neither rule, so every control competed for one row and the trailing group wrapped abruptly as a block.

## Decision

The composer `.row` is the anonymous inline-size container (already declared for the model trigger's `cqw` cap), and the chips degrade on it at the shared 480px narrow-panel step from the responsive-shell vocabulary: `PermissionSelect` keeps its level-varying glyph and chevron, `ModelSelect` swaps the name and effort for a new `IconSparkle16` glyph plus chevron while `aria-label` and `title` keep the full identity. Below 300px the trailing group takes its own full-width row — the container version of the existing ≤359px compact rule. All degradation is CSS-only; mounts without a container ancestor (the session settings sheet) never match and keep their labels.

## Alternatives considered

**Two fixed rows below a threshold.** Rejected: spends a second row whenever the column narrows, though icon-tier chips still fit on one line.

**Summary pill into the settings sheet at higher widths.** Rejected: hides the current model and permission behind a second tap; the sheet entry stays a phone-only behavior.

**New container steps outside 480/560/720.** Rejected: the shared vocabulary exists so panels degrade at the same widths; a long model name with its effort suffix legitimately needs the collapse near 480 anyway.

## Consequences

Any narrow composer — phone, narrow window, or a workbench column at any viewport width — degrades identically because the queries answer the card's own width. The visible label area per chip drops to 44px at the icon tier; both keep accessible names and tooltips. The ≤359px unmount-to-summary phone path is untouched, and so is the model menu's bottom-sheet presentation.

## Verification

`compact-chrome-styles` and `model-select-styles` assert the container steps against the stylesheet text, and a `model-select` spec pins the glyph's `aria-hidden` seat with the full name on `title`/`aria-label`. Browser-checked on the built app at composer widths 296–780px: labels above 480, icon chips at and below, trailing row only under 300.

## Related

- [Responsive shell viewport modes](../architecture/2026-08-14-responsive-shell-viewport-modes.md) — the anonymous-container and shared-step vocabulary this follows.
- [Compact chrome density](../architecture/2026-08-19-compact-chrome-density.md) — the compact-viewport rules this complements.
