# Agent Note: Session header actions stay on one line

Status: implemented
Archived: 2026-08-18

English | [中文](2026-08-18-session-header-actions-stay-single-line.zh.md)

## Problem

The Session header composes the conversation title, project visibility, agent preset, subagent catalog, and utilities in one row. The project-sharing action also rendered a persistent participant card with its own minimum width and multiple text rows, while the subagent trigger allowed its count label to wrap. At constrained desktop conversation widths, those controls consumed the title area and made adjacent labels stack or cover one another.

## Decision

The project-sharing action renders one inline trigger containing the visibility, participant count, and disclosure icon. Creator names, participant names, and contribution counts remain in the existing menu instead of repeating below the trigger. The sharing and subagent triggers each keep a single-line footprint without changing text layout inside their menus. The existing breadcrumb remains the flexible region and truncates before these compact controls collide.

## Verification

The collaboration component suite pins that participant details are absent while the menu is closed and appear once inside the menu. An assembled Chromium scenario mounts project sharing, the PTC preset label, six subagents, and the Session utility at a 1024px desktop viewport; its geometry golden verifies a single row, ordered non-overlapping rectangles, menu-only participant details, and the subagent trigger's no-wrap style.

## Alternatives considered

**Keep the participant preview and wrap the whole header.** Rejected because a two-row header changes the conversation chrome height as optional plugins appear and separates controls from the title they describe.

**Hide the preset or subagent action at constrained desktop widths.** Rejected because both identify active Session behavior. Compacting duplicated collaboration detail preserves all three controls without removing context.

**Keep participant chips beside the visibility trigger.** Rejected because the menu already owns the complete roster and contribution counts; a second copy spends permanent header width on information used only when inspecting collaboration details.

## Consequences

The Session header keeps a stable single-line height and preserves every action at constrained desktop widths. Participant details require opening the sharing menu, while the visible participant count still signals that collaboration activity exists.
