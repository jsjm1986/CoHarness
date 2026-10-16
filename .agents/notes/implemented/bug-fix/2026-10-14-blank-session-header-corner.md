# Agent Note: Keep the session header corner seat mounted on blank Sessions

Status: implemented

English | [中文](2026-10-14-blank-session-header-corner.zh.md)

## Problem

`ConversationSessionHeader` unmounted its whole inner tree while `blank && composerPhase === 'blank'`, including the `conversation.session.header.corner` seat. Upstream keeps the corner mounted precisely in that phase — `hideChrome` blanks title, tabs, actions, and utilities only. Because the seat disappeared, `ui-sidebar-right` registered a second `ExpandButton` into `conversation.input.left` just for blank Sessions, so the right-sidebar affordance existed in two places with two mount rules.

## Decision

The corner seat renders outside the blank-chrome guard, matching the upstream contract: on a blank Session the header mounts with only the corner occupant; title, tabs, actions, and utilities stay deferred until conversation chrome applies. `BlankExpandButton` and its `conversation.input.left` registration are deleted — the corner registration now covers every phase, and a second seat would render the same control twice.

- `headerBlank` replaces `headerHidden`: the header drops its hairline and bottom padding on blank Sessions, keeps its padding-top so the corner sits in a stable row, and collapses entirely when the corner itself renders nothing (`:has` on the empty seat).
- The non-blank `titleRow` also gives the corner its own seat after `headerUtilities`, matching the upstream corner-vs-utilities ordering instead of nesting the seat inside utilities.
- `aria-hidden` is dropped: a blanket-hidden header containing an interactive corner control would be an accessibility contradiction.

## Alternatives considered

**Keep `BlankExpandButton`.** With the corner mounted it produces two expand controls on the same screen — the hero composer row and the header — and the dual registration is the workaround, not a feature. Upstream never needed it because the corner seat never unmounted.

**Collapse the header to `display: none` when blank.** That was the original failure: any corner occupant loses its mount, and every consumer needing a blank-phase control has to re-register elsewhere.

## Consequences

The right-sidebar expand control stays reachable across the blank → active flip without a composer-side duplicate, and `conversation.session.header.corner` now carries one contract in every phase: session-scoped navigation seats survive conversation-chrome phases. An empty corner keeps the header collapsed, so hero Sessions without a corner occupant look exactly as before.

## Verification

`ui-conversation` skeleton spec — a blank-phase case asserts the header mounts with the corner seat and without actions, utilities, or tabs; the hero-phase case asserts the corner seat exists inside the mounted header. `ui-sidebar-right` specs — registration lists drop the `conversation.input.left` entry, the reload count drops to 7, and the corner `ExpandButton` test covers the blank phase directly. 681 + 262 tests pass.

## Related

- [GUI Web client architecture](../architecture/2026-07-19-gui-web-client-architecture.md) — the slot composition these seats live in.
