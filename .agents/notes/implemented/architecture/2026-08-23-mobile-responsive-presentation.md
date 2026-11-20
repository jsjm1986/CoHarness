# Agent Note: Mobile responsive presentation for the Web workbench

Status: implemented

English | [中文](2026-08-23-mobile-responsive-presentation.zh.md)

## Problem

The Web workbench has one business model but several mobile-visible domains: Workspace and Session navigation, blank-session creation, Chat, composer takeovers, Tool output, Trajectory inspection, settings, and document management. The compact layout currently keeps desktop information order and adds local CSS exceptions. On short phone viewports this duplicates chrome, lets the composer cover transcript content, and leaves diagnostic controls competing with message reading. Replacing those exceptions independently would make each new plugin invent another mobile policy.

## Decision

Use one business and plugin system with a shared design foundation and mode-specific presentation at information-architecture seams. The client object layer, Session event semantics, Workspace actions, slot ownership, composer chain, and Tool/Trajectory data remain shared. `ui-layout` owns the viewport profile, compact shell geometry, and one overlay/scroll policy. Shared primitives own mobile top bars, drawers, sheets, action overflow, and page scaffolds. Feature packages may provide a mobile presenter when its hierarchy differs materially from desktop; simple density changes stay in the shared presenter and CSS token system.

The phone workbench uses one contextual top bar, a full-height navigation drawer, a single transcript scroll owner, and a composer dock whose measured height is reserved rather than painted over content. Frequently used secondary actions remain reachable through touch-sized controls or one bottom sheet. Stats, raw Tool payloads, Trajectory timing, settings sections, and document operations use progressive disclosure while retaining their desktop capabilities. Workspace and Session rows keep the existing reuse, archive, rename, fork, search, pending-interaction, and subagent rules; only their mobile grouping and action placement change. `ui-primitives` owns the shared phone-sheet backdrop and `Modal` focus loop; feature presenters reuse those surfaces and add a mobile-only back row only where a hierarchy changes.

The responsive contract is evaluated at shell boundaries from viewport width, short-height state, safe-area and pointer capabilities. Feature components do not create parallel business stores or read Host services directly. New mobile presenters use the existing four props shares and slot declarations, and shared state remains in the object layer or the declaring entry store according to the client architecture rules.

The composer fits compact controls against the toolbar's measured width, since optional slots change the space needed within a pane. Touch-first devices keep those controls in landscape when the surrounding shell expands. An occupied status seat can move to the footer with its trigger and open details intact. Keeping the trigger in flow places pointer targets and keyboard order together.

Every AppFrame width mode uses the shared visible-viewport height, capped by its parent’s height. Landscape phones can cross the medium breakpoint while their keyboards still reduce only the visual viewport; a width-only keyboard rule leaves the composer behind the keyboard. Portaled modals and image lightboxes consume the same height rather than establishing another viewport listener. When a session header and editable content cannot fit together, the conversation root can scroll the header away while retaining a reachable inner content region, including inside Workbench panes. A Workbench scrolls its toolbar and rows when their intrinsic headers and each expanded pane’s minimum content area exceed the visible height. Pointer capability controls hover feedback and touch target sizing independently of width. Reduced-motion preferences retain state feedback while removing animated positioning. Tooltip focus and hover ownership lasts until dismissal or leaving both trigger and content; opening another unrelated tooltip dismisses its predecessor without a global active-tooltip registry.

Short panels place form controls and content in one scroll region when fixed toolbars would leave too little room to read or edit. A height-dependent container query requires a definite container height. Growing answer fields cap their own height below the available scrolling surface, preserving touch targets and internal draft scrolling. Browser acceptance checks real clipping ancestors and user-scrollable paths; moving an `overflow: hidden` ancestor programmatically is not evidence that its controls are reachable.

Default modal titles and dismissal controls occupy a separate row above their scrolling body. This preserves orientation while reading long content without overlapping code toolbars or focused fields. When the shared visible-height container cannot accommodate fixed rows and usable content, the entire card scrolls instead; the layout viewport alone cannot detect a keyboard leaving only a narrow reading strip. Headless presenters retain their own navigation and scroll owners. Review summaries cap their initial height against the same visible-height value and retain internal text scrolling.

Transcript jumps occupy an inline-end inset beside message links. Short document menus preserve search focus through pointer activation. Skill reading and Forge review keep the header above a scrolling body when the viewport can hold both. Shared text sizes use relative units with the browser’s operating-system scale opt-in.

Chat returns a composer at least as tall as its scrollport to normal flow, removing overlap clearance from transcript padding and floating navigation. Automatic tail following aligns the beginning of an oversized composer with the scrollport and reveals its focused draft through enclosing scroll areas. Manual scrolling can reach the remaining controls or retain an earlier message without invoking that focus adjustment. When a short conversation panel places the composer in normal flow, the Trajectory ledger reserves no additional composer clearance. Trajectory details scroll as a whole, including summary and actions, so nested fixed sections cannot consume the reading area. Document management gives the current folder a heading, separates navigation and actions from search, and omits filters and zero counts for an unfiltered empty folder. Short screens group directory actions horizontally where they fit and keep empty-state and upload information compact without reducing touch targets. Upload progress separates completed files from the current file's byte transfer or finalization, keeping the action label stable. Attachment controls appear only when a conversation can receive them; selection mode keeps its destination guidance. Document action and scope dialogs retain their owner and input state across width changes. Visual review checks content hierarchy, alignment, and spacing alongside control reachability.

Global panel selection closes the compact navigation drawer in the same store action, including selection of the already-active panel. The medium rail retains its expansion. A rendered destination under a still-open drawer is not completed mobile navigation; browser acceptance waits for drawer dismissal before interacting with the destination.

A fullscreen details panel uses its AppFrame’s measured width and clears the frame’s normal outer inset. Embedded frames remain the fullscreen container. Composer height and clipping observers publish subsequent visual measurements in an animation frame and cancel pending updates on unmount, preventing same-frame ResizeObserver feedback.

The sidebar retains its React owner when switching between a compact drawer and a desktop column. A body portal does not preserve its state if its owning sidebar unmounts; keeping the owner stable preserves open Settings forms and input focus through rotation. The closed compact drawer holds a reference-counted `inert` claim on its retained sidebar, keeping descendants with explicit visibility out of pointer and keyboard interaction. Opening, widening, or unmounting releases that claim without releasing isolation owned by another overlay. Scope-selection overlays use the same shared claims for covered sidebars, so dismissal or resize cannot restore a stale `inert` snapshot.

On phones, a risk confirmation stays above its owning settings sheet and backdrop while the sheet remains mounted. Cancelling restores focus to the sheet's triggering option; dismissing the sheet then restores focus to the composer control. Text-bearing model and plugin form controls use minimum heights so enlarged text can grow without clipping.

Related shipped local decisions are [responsive shell viewport modes](2026-08-14-responsive-shell-viewport-modes.md), [compact chrome density](2026-08-19-compact-chrome-density.md), [settings overlay portal](2026-08-19-settings-overlay-portal.md), and [mobile composer model seat](../bug-fix/2026-08-17-composer-mobile-model-seat.md).

## Alternatives considered

**Sticky modal headings inside the body scrollport.** They can overlap sticky code toolbars and newly focused controls. Separate rows reserve the required space; the whole-card fallback trades persistent chrome for control reachability at extreme keyboard heights.

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

The assembled browser scenarios cover shell breakpoints, drawer navigation, open-form rotation, plugin configuration, mobile confirmations, and text enlargement. Chromium and WebKit use the same shell and form scenarios. The [browser testing guide](../../../../apps/web/tests/README.md#mobile-acceptance) owns the size matrix, commands, screenshot options, and physical-device acceptance limits.
