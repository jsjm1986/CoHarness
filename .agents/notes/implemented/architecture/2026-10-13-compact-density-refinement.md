# Agent Note: Compact density refinement for phone viewports

Status: implemented

English | [中文](2026-10-13-compact-density-refinement.zh.md)

## Problem

A second phone audit at 390×844 showed the compact pass had left the largest surfaces on desktop scale: the conversation header still spent ~83px on a two-row title-plus-tabs recipe, the composer seat ~128px on desktop card padding, code blocks kept 16px card radius and a 44px banner, message actions sat on 44px targets, and every session row permanently rendered three trailing buttons — compressing a "NavScenario: first run…" title to "NavS…". Two interaction leaks compounded the bulk: a touch tap's synthesized `mouseenter` armed hover tooltips that painted over the tapped control, and the approval takeover card had no compact recipe while its question/plan siblings already did.

## Decision

Density, not re-layout. Every change is a `[data-viewport='compact']` or `pointer: coarse`/`max-width: 767px` rule inside the owning package — no JS contract, slot, or data-path changes beyond two deliberate behavior edits.

**Conversation chrome.** The compact header becomes a single 36px strip under the app topbar; the tabs track drops to 34px with 28px pills, `mobile-font-secondary`, and horizontal scroll so long labels never clip the utilities. Root side clearance falls to 12px, transcript column gap to `--dsw-space-3`, and scroll inset to clearance+6.

**Composer and transcript.** The input card tightens to `6px 12px 8px` padding with the mobile card radius and a 4px toolbar gap; the icon row already rides the 40px single-line compromise. User bubbles drop to `--dsw-radius-lg` with 8px/12px padding; message actions take the same 40px target family inside a 36px wrapping row; fenced code adopts a 10px card radius, a 40px banner row, a 40px copy control, and `10px` code insets — the banner is chrome, not a tap row, so it tracks the composer's icon family instead of the 44px touch target.

**Rows and takeovers.** Session rows collapse their trailing strip to the ellipsis menu alone: `row.action` slot buttons move inside a `display: contents` wrapper that collapses on compact and coarse pointers, because every contributor (pin, archive) already publishes the same verb as a `menu.item`, and three permanent 44px buttons on a 330px row traded the title for duplicated reach. The selected row keeps a flat `interactive-bg-active` fill — a raised pill reads as a button inside a full-width drawer. `ApprovalPanel` joins the shared compact takeover recipe (16px radius, `space-3` insets, wrapped action row) so the composer seat swap stops jumping widths.

**Hover gate.** `Tooltip` no longer arms its hover trigger when `matchMedia('(hover: hover)')` reports no hover capability; touch and jsdom contexts keep the focus/click paths, and synthetic touch `mouseenter` events can no longer pin a keyboard-shortcut bubble over the control the tap just activated.

**Accelerator hints on touch.** Menu `shortcut` key hints hide under `@media (pointer: coarse)`: a bottom-sheet row on a keyboardless device paid trailing-cell width for unusable information. The `aria-keyshortcuts` declaration stays for assistive tech, and hybrid devices keep full behavior — only the visual hint drops.

**Secondary stats segments.** Each composer stats pill keeps only its primary figure on compact: the speed segment and the cache-hit segment hide inside a `detail` span, because two pills at 390px ellipsized mid-number sooner than they informed. Tap-open dialogs still carry every figure, and the pill `aria-label` keeps the full reading.

**Drawer stack.** The phone drawer narrows to `min(82%, 300px)` so more transcript stays visible behind the scrim, and the header stack (brand row, New Session CTA, panel nav column, group header) sheds about 12px of vertical padding so the list starts sooner. Session rows keep the 44px target but regain their relative-time stamp at the caption tier — single-line "未命名" rows read as sparse placeholders without it — and an idle row's leading status slot collapses (`:has(> :only-child:empty)` over the display:contents host) so titles land near the group inset instead of floating mid-row.

**Platform press and list rhythm.** `-webkit-tap-highlight-color: transparent` retires the browser's grey tap flash (interactive surfaces already carry explicit `:active` fills), and on compact the project/session/search rows answer a press with an instant `interactive-bg-active` fill instead of the desktop 0.98 scale nudge — a full-width cell that squishes reads as elastic, not tappable. Session cells sit contiguous with 0.5px inset hairlines drawn on each row's HoverCard wrapper (`span:not(:last-child)::after`; the row classes belong to a different CSS-module scope, and the wrapper's sibling position is the reliable group-end test). The New Session CTA takes the primary button fill on phone — a full-width neutral slab reads as a disabled band. `overscroll-behavior: contain` on the drawer list and transcript scrollport keeps end-of-scroll momentum from chaining into the page behind.

**Phone gestures.** The compact drawer is swipe-driven: a rightward pan starting on a 24px left-edge zone opens it and a leftward pan on the open drawer closes it, both tracking the finger with live scrim opacity and settling on a 30%-of-width or velocity threshold. `useSheetSwipeDismiss` gives Modal and Menu sheets platform-style dismissal — a downward drag anywhere on the sheet follows the finger and fades the scrim, release past 96px or velocity 0.35 closes, a short release glides back via an inline transform transition, and a scrollable ancestor that is not at its top consumes the pan instead. Listeners are native and non-passive because React binds touch handlers passive and the gesture needs `preventDefault` once intent resolves; both paths are inert above `max-width: 767px` and under `prefers-reduced-motion`.

## Alternatives considered

**Hold the 44px touch target everywhere.** Rejected: a single-line composer toolbar and a one-row message-action strip cannot hold five 44px controls at 360–390px; the 40px family is already the codified compact compromise ([composer single icon row](../bug-fix/2026-09-18-composer-single-icon-row.md)), and genuinely interactive rows (menu rows, option rows, session rows) keep the full touch target.

**Swipe or long-press for session row actions.** Rejected: there is no gesture layer in the row component, and the ellipsis menu already carries every verb; duplicating pin/archive as permanent row furniture only squeezed the title.

**A second compact presenter for takeover cards.** Rejected: `QuestionComposer` and `PlanReviewPanel` already share the `@media (max-width: 767px)` recipe; ApprovalPanel's divergence was omission, not intent, so it adopts the same block.

## Consequences

Phone chrome loses roughly 40px of fixed vertical cost and transcript cards stop reading as desktop windows; the session list shows full titles with a single trailing affordance. Coarse-pointer desktops that are not compact (tablets at medium widths) keep the 44px rules; the desktop build is byte-identical outside the gated rules. Consumers relying on hover tooltips on touch-only devices lose nothing — the bubble never fit the interaction; devices with hover (trackpads, hybrid tablets) behave exactly as before.

## Verification

`apps/web/tests/mobile-density.e2e.ts` boots the real assembled app at 390×844 on a seeded session and asserts the compact stamp is active, a session row's visible trailing strip is exactly the menu trigger, the transcript scrollport shows no horizontal overflow, and a synthesized hover arms no tooltip bubble. The lexical contracts in `compact-chrome-styles.client.spec.ts` and `compact-styles.client.spec.ts` now pin the 36/34/28px header recipe and the 40px code-banner family. Screenshot review at 390×844 covered landing, drawer (collapsed and expanded), conversation, composer, details overlay, trajectory feed, and the settings bottom sheet; a 1440×900 reference shot confirmed the desktop frame is unchanged. `ui-workspace`, `ui-conversation`, `ui-sidebar-right`, and `ui-primitives` suites pass. `apps/web/tests/swipe-check.e2e.ts` replays the gesture layer with real TouchEvent sequences at 390×844: edge-swipe opens, drawer pan closes, a slow short sheet drag snaps back, a long drag dismisses both Menu and Modal sheets, and a scrolled sheet consumes the pan.

## Related

- [2026-08-19 Compact chrome density](2026-08-19-compact-chrome-density.md) — owns the compact/coarse gating convention this pass extends.
- [2026-08-25 Mobile navigation and reading density](2026-08-25-mobile-density-pass.md) — the first density pass; drawer and markdown rhythm stay as it decided.
- [2026-09-18 Composer single icon row](../bug-fix/2026-09-18-composer-single-icon-row.md) — owns the 40px compact target compromise the action row and code banner now share.
