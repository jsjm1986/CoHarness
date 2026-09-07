# Agent Note: Document workbench visual hierarchy

Status: implemented

English | [中文](2026-09-07-document-workbench-visual-hierarchy.zh.md)

## Problem

The document manager presented navigation, scope state, filters, actions, and rows with similar visual weight. The flat desktop panel made the workbench feel fragmented, while larger listings paid layout and paint costs for rows outside the viewport.

## Decision

The manager keeps its existing DOM, operation order, permissions, and request behavior. The stylesheet establishes a single hierarchy: the scope rail is a quiet navigation surface, the content panel is a raised task surface, status and filter controls share consistent spacing, and document, overview, and trash rows use the same metadata rhythm and hover treatment. Active scopes use a restrained brand edge for orientation rather than a second accent system.

Document rows, overview rows, and trash rows use `content-visibility: auto` with intrinsic size hints and layout, paint, and style containment. The browser can skip work for off-screen metadata while preserving the existing scrollports and accessible row semantics.

Scrollable navigation and list surfaces reserve a separate inline track for their scrollbar, so selected backgrounds and row borders do not sit beneath the scrollbar thumb.

## Alternatives considered

**Rewrite the component tree around new card and toolbar components.** Rejected because the request is presentation-only and the current DOM already carries the required accessible relationships and operation handlers.

**Use a dense table with fixed columns.** Rejected because long document names, compact layouts, and the existing mobile action sheets require flexible metadata widths.

**Virtualize the list in JavaScript.** Rejected because virtualization would add scroll measurement state and risk changing selection, paging, and accessibility behavior; CSS containment addresses the rendering cost without changing list semantics.

## Consequences

The manager reads as one workbench with clearer navigation, task, status, and row layers. Desktop rows gain a quieter separator and consistent hover rhythm; compact layouts retain their touch targets and sheet geometry. Large listings avoid unnecessary off-screen layout and paint work. The stylesheet uses `color-mix()` for token-derived blends and keeps the existing theme tokens as its color authority.

## Verification

The document manager stylesheet test checks the raised content panel, active-scope indicator, and row containment rules. The component suite and the UI documents TypeScript aggregate pass with the existing scope, action, and responsive behavior coverage.
