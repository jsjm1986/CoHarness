# Agent Note: Mobile composer reserves the model seat

Status: implemented

English | [中文](2026-08-17-composer-mobile-model-seat.zh.md)

## Problem

The composer row contains fixed-size touch controls on the left and model, context, and send controls on the right. On a narrow card, shrinking the left flex item lets its children paint outside that item while the non-shrinking trailing group keeps the model trigger at its intrinsic width. A long model name can therefore be covered by a left-side icon or can cover the send controls.

## Decision

The left tool group keeps its intrinsic width with `flex: 0 0 auto`. The trailing group becomes the flexible region and keeps its fixed controls at the end of the row. `ModelSelect` owns the remaining model width with `min-width: 0`, a 220px desktop cap, and a full-width trigger, so the label truncates inside its own seat. The reasoning-effort label is hidden below the row's 480px container step; the menu and trigger title retain the complete selection details.

## Verification

The assembled Chromium scenario selects `deepseek-v4-flash-0731` through the real model menu, checks toolbar rectangles at 390px and 375px widths, and replays a keyless geometry golden. It also checks that visible tool controls stay before the model trigger, the model trigger stays before Send, and the label keeps ellipsis styles. The focused model-selection and input-bar suites pass 76 tests, and both affected client packages bundle successfully.

## Alternatives considered

**Allow every row child to shrink.** Rejected because the left touch controls can still paint beyond a compressed flex item; a smaller item does not clip or reflow its descendants.

**Wrap the model label onto a second line.** Rejected because the composer row changes height and pushes the send affordance while the model identifier remains difficult to scan.

**Abbreviate or remove the model identifier on phones.** Rejected because users lose the selected route's identity; truncation plus the title and menu preserves access to the full name.

## Consequences

The model seat can become narrow at phone widths, but it cannot overlap a neighboring control. Left-side touch targets retain their hit areas, while secondary effort text gives up inline space on small rows and remains available through the model menu and accessible title.
