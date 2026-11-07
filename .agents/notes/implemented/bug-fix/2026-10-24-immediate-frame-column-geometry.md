# Agent Note: Immediate frame column geometry

Status: implemented

English | [中文](2026-10-24-immediate-frame-column-geometry.zh.md)

## Problem

Restoring an auxiliary panel can change the conversation's width as historical text becomes visible. Interpolating grid columns then wraps the same text at successive widths and repeatedly recalculates layout. A public navigation diagnostic recorded a cumulative layout shift of 0.29; a reduced-motion control on the same release recorded 0.00. That control identifies motion as a cause but does not measure a particular stylesheet change.

## Decision

AppFrame applies column widths and resize-strip positions directly. The column solver still owns dimensions and concessions; the [auxiliary-panel owner](../feature/2026-09-04-right-sidebar-docking-infrastructure.md) still owns visibility, track reservation and fullscreen presentation. Panel transforms and opacity retain their independent motion rules.

Each resize strip owns its pointer-capture state and hover affordance. Frame-wide drag state is unnecessary when column geometry does not interpolate.

## Alternatives considered

**Disable all motion.** Reduced motion provides a diagnostic control, but a layout optimization does not require removing unrelated indicators and panel transitions or changing the user's motion preference.

**Animate only after restoration.** This needs a separate distinction between restored and interactive layout changes and still reflows text on later panel changes. The frame already has the final dimensions in both cases.

## Consequences

Opening or closing a column changes the conversation width immediately instead of easing it. The real Web composition records its content-column widths from the expansion commit through four animation frames; the geometry expectation requires one distinct width. Existing auxiliary-panel snapshots also cover collapse, reload and compact presentation. These checks establish DOM geometry, while public navigation measurements establish the resulting layout stability.
