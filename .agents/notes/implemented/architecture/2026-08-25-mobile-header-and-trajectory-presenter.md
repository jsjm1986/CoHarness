# Agent Note: Share mobile chrome contracts while projecting trajectory events for phones

Status: implemented

English | [中文](2026-08-25-mobile-header-and-trajectory-presenter.zh.md)

## Problem

The compact conversation used a desktop-oriented header and trajectory table, so low-frequency utilities consumed a full row and event content was difficult to scan in a phone-sized viewport. Adding one-off CSS overrides would leave future session tools and trajectory fields without a stable placement contract.

## Decision

The layout owns a session-scoped `shell.mobile.header.actions` slot and passes the resolved compact mode through the conversation owner props. AppFrame renders that slot in a 44px phone topbar; desktop utilities remain in their existing session-header slots. Session-log export shares one controller and dialog between its desktop and mobile presenters.

Trajectory keeps one record projection, selection controller, history pager, search index, and virtual-row identity. Desktop renders the existing table; compact renders `TrajectoryMobileFeed` with fixed phone row metrics, a primary line, a metadata line, and the same record/request selection callbacks. Mobile details use the existing inspector fields in a bottom sheet, while desktop keeps the resizable side panel.

Shared mobile metrics in `ui-theme` own header, toolbar, timeline, feed-row, typography, icon, and safe-area values. Feature CSS consumes semantic aliases and does not introduce a second palette or per-row elevation system.

## Alternatives considered

**Position the existing Session header over the AppFrame with negative margins.** Rejected because the placement depends on shell heights, creates overlapping focus order, and gives future session utilities no declared owner.

**Keep the desktop table and shrink its text until it fits.** Rejected because wrapped table cells still expose desktop columns and make primary event text compete with metadata on narrow screens.

**Maintain separate mobile trajectory state and data loading.** Rejected because duplicate paging, search, streaming, and selection logic would drift from the desktop ledger.

## Consequences

New phone-only session utilities register in the mobile header slot and provide their own compact presenter. Trajectory changes extend the shared record projection once, then add mobile presentation fields without changing the session log, backend API, or durable format. The mobile presenter uses fixed row metrics so virtualization can preserve prepend anchors without runtime text measurement.
