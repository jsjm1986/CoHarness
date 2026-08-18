# Agent Note: Compact chrome density for phone viewports

Status: implemented

English | [中文](2026-08-19-compact-chrome-density.zh.md)

## Problem

Settings overlay scrolling was fixed separately. The rest of the assembled Web chrome still used desktop density on compact viewports: the workspace directory picker kept two 256px Miller columns inside a 390px bottom sheet; hero headline and workspace/preset chips did not wrap; composer attach/send, sidebar glyphs, session-row overflow menus, and message actions stayed 16–34px; hover-only session actions never appeared on touch. Information clipped and controls were hard to tap. No Host, session, or settings write paths changed.

## Decision

CSS-only compact and coarse-pointer rules, no JS or slot contracts. Portaled sheets (`DirectoryBrowser`, Menu, Modal, onboarding content max-height) use `@media (max-width: 767px)`. In-frame chrome uses `:global([data-viewport='compact'])` so it follows the shell stamp. Compact and coarse both grow sub-40px controls to `--dsw-touch-target` and keep hover-only row actions visible: some phone WebViews report `pointer: fine`, so the compact stamp must carry density, not only coarse media. Compact Miller columns become one full-width snap pane each so Open/Cancel stay reachable and share the footer row. Desktop two-column Miller and 28px composer chips are unchanged on fine pointers in medium and wider viewports.

Related: [responsive shell viewport modes](2026-08-14-responsive-shell-viewport-modes.md), [settings overlay portal](2026-08-19-settings-overlay-portal.md), [sidebar footer stacked rows](2026-08-19-sidebar-footer-stacked-rows.md).

## Alternatives considered

**Raise every Button to 44px on coarse pointers.** Already rejected for the shell token pass: dense desktop-shared layouts reflow. This change only grows the sub-40px controls that are the tap targets.

**Replace Miller columns with a single stacked list.** Rejected: the picker already scrolls the Miller row; full-width snap panes keep parent/child descent without a second navigation model.

## Consequences

Phone users can finish workspace pick, tap composer/sidebar/session overflow, and read the hero row without horizontal clip. Compact composer toolbars wrap so the model label keeps a real width. Coarse and compact session rows hide the time label so always-visible actions fit. Compact conversation header tabs scroll horizontally. Portaled menus cap height and scroll; directory Open/Cancel share one stretched footer row. Compact chat tool summaries, stats, reasoning/command rows, and trajectory cells wrap instead of clipping; the jump-to-bottom control, trajectory close, produced-file chips, and workflow run header meet the shared touch target. Portaled HoverCard, Toast, RiskConfirmation, and the image lightbox close control stay inside the 767px sheet, with Toast and usage alerts respecting `--dsw-safe-top`. The sidebar foot stacks `sidebar.footer.action` as full-width Settings rows above Settings so scope, Cordis, and Documents no longer share one crushed line.
