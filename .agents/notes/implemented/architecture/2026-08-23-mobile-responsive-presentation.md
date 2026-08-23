# Agent Note: Mobile responsive presentation for the Web workbench

Status: implemented

English | [中文](2026-08-23-mobile-responsive-presentation.zh.md)

## Problem

The Web workbench has one business model but several mobile-visible domains: Workspace and Session navigation, blank-session creation, Chat, composer takeovers, Tool output, Trajectory inspection, settings, and document management. The compact layout currently keeps desktop information order and adds local CSS exceptions. On short phone viewports this duplicates chrome, lets the composer cover transcript content, and leaves diagnostic controls competing with message reading. Replacing those exceptions independently would make each new plugin invent another mobile policy.

## Decision

Use one business and plugin system with a shared design foundation and mode-specific presentation at information-architecture seams. The client object layer, Session event semantics, Workspace actions, slot ownership, composer chain, and Tool/Trajectory data remain shared. `ui-layout` owns the viewport profile, compact shell geometry, and one overlay/scroll policy. Shared primitives own mobile top bars, drawers, sheets, action overflow, and page scaffolds. Feature packages may provide a mobile presenter when its hierarchy differs materially from desktop; simple density changes stay in the shared presenter and CSS token system.

The phone workbench uses one contextual top bar, a full-height navigation drawer, a single transcript scroll owner, and a composer dock whose measured height is reserved rather than painted over content. Frequently used secondary actions remain reachable through touch-sized controls or one bottom sheet. Stats, raw Tool payloads, Trajectory timing, settings sections, and document operations use progressive disclosure while retaining their desktop capabilities. Workspace and Session rows keep the existing reuse, archive, rename, fork, search, pending-interaction, and subagent rules; only their mobile grouping and action placement change. `ui-primitives` owns the shared phone-sheet backdrop and `Modal` focus loop; feature presenters reuse those surfaces and add a mobile-only back row only where a hierarchy changes.

The responsive contract is evaluated at shell boundaries from viewport width, short-height state, safe-area and pointer capabilities. Feature components do not create parallel business stores or read Host services directly. New mobile presenters use the existing four props shares and slot declarations, and shared state remains in the object layer or the declaring entry store according to the client architecture rules.

Related shipped local decisions are [responsive shell viewport modes](2026-08-14-responsive-shell-viewport-modes.md), [compact chrome density](2026-08-19-compact-chrome-density.md), [settings overlay portal](2026-08-19-settings-overlay-portal.md), and [mobile composer model seat](../bug-fix/2026-08-17-composer-mobile-model-seat.md).

## Alternatives considered

**One desktop DOM with additional compact CSS.** Rejected: it preserves the wrong information order and turns every new feature into another breakpoint exception; the current compact density, composer-seat, and settings fixes do not solve the shared overlay and prioritization problem.

**A separate mobile application and business implementation.** Rejected for the current rapid-iteration phase: duplicated Session, Workspace, plugin, and interaction logic would drift and would require two behavior test lanes. A separate presentation is allowed only where the hierarchy genuinely changes.

**A single giant mobile shell that owns every feature.** Rejected: it would bypass plugin ownership and make optional capabilities depend on a central component. The shell owns mode and surfaces; each package owns its content and actions through the existing slot system.

## Consequences

- The phone shell has one contextual top bar, one navigation drawer, and one active scroll owner; no primary content or answer action is hidden under a fixed composer.
- Workspace selection, blank-session creation/reuse, Session navigation/search, send/queue/steer, model selection, permission changes, approvals, questions, Tool details, Trajectory inspection, settings, and document attachment remain reachable on phone viewports.
- Mobile and desktop share the same Session/Workspace state and action outcomes; no model-visible or durable event changes are introduced by presentation work.
- New feature contributions have a documented mobile placement and reuse shared primitives instead of adding ad-hoc viewport listeners or contradictory breakpoints.
- Browser checks cover 320–430px portrait, short phone heights, keyboard-visible layouts, safe areas, dark mode, long labels, pending takeovers, and desktop regression.

## Risks

Mode-specific presenters add a second markup path for a small set of hierarchy-heavy surfaces and therefore require paired behavior and visual checks. Preserving one business source of truth limits that risk; the mobile path must not fork Session state, command dispatch, or Host authority. Existing compact notes remain applicable for their local guarantees and are superseded only where this decision defines a broader presentation policy.

## Implementation evidence

The client package lane passes with 279 test files and 3,749 tests. The responsive shell browser lane passes at compact, short-compact, medium, expanded, and round-trip sizes. Seeded browser lanes that require live WebSocket session streams remain environment-blocked when the local Chromium run cannot complete the `/api/events.mux` and `/api/events.host` upgrade; the UI changes do not alter those protocol routes.
