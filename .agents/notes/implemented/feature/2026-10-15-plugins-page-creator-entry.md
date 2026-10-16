# Agent Note: The Plugins page add menu carries the Creator entry

Status: implemented

English | [中文](2026-10-15-plugins-page-creator-entry.zh.md)

## Problem

The conversational plugin-authoring flow — stage the `cordis` preset, open a blank session, execute only once the user sends a requirement — was reachable only from the Agent presets settings section. Upstream alpha.2 exposes the same draft from the Plugins page's add control, which is where a user looking to extend the product actually stands. The local page's single install button had no opening for contributed actions, and a second entry must not fork the draft: two implementations of "stage `cordis` and start a session" would drift on exactly the semantics that make it safe.

## Decision

`ui-plugin-manager` turns **Add plugin** into a split control: the primary button still opens the install dialog, and an adjacent chevron opens a menu that leads with the same install action followed by the `plugins.add.actions` slot — a root-scoped list the page declares on its `main` registration. Contributed items receive `onDismiss` so an entry can close the menu before it navigates.

`ui-agent-preset` contributes `CreatePluginMenuItem` (id `create-plugin`) into that slot, bound to the same `creatorDraft` closure the settings section's button calls — one staging path, not two. The item loads the preset roster on mount and renders an explanatory disabled row for every non-ready state (loading, unavailable, error, missing `cordis`); it is enabled only when the roster reports ready, which already implies `modeSelectionEnabled`. Selecting it dismisses the menu first, then stages `cordis` with the introduce cue and starts a new session — the draft semantics are unchanged: nothing is sent until the user types a requirement.

The launch guard reads both surfaces' evidence: the section store's `showPicker` or the shared roster's ready status. An entry the user never opened cannot veto a launch the opened one already proved possible.

Launching from a main panel requires an explicit return to the Conversation. `layout.selectPanel(null)` runs inside `creatorDraft` before `startSession`: a no-workspace clear and a same-session reuse emit no selection change, so the panel would otherwise stay mounted over the draft. The same gap existed on the shell's New Session button and the Workspace browser's start actions; both now reset the panel at the gesture — in `ui-sidebar`'s injection and the shared `uiWorkspace.startSession` face — matching the reset `openSession` already performed on commit.

## Alternatives considered

**A hardcoded Creator item inside `ui-plugin-manager`.** The Plugins page would import agent-preset concepts — roster state, the `cordis` id, seat staging — inverting the layering the slot system exists for. The page owns the menu chrome; the preset plugin owns the entry.

**A separate draft path for the menu.** Rejected: the stage-then-wait semantics and the introduce cue belong to one code path; duplicating them to keep the stores apart would recreate the drift the shared closure prevents.

**Sending a starter requirement automatically.** The draft's purpose is that the user authors the requirement; auto-sending would turn a menu entry into a silent agent run.

## Consequences

`ui-agent-preset` gains type-only edges to `dsh-client-ui-plugin-manager` (the `plugins.add.actions` SlotMap merge) and `dsh-client-ui-layout` (the `ctx.layout` merge) — matching peer plus dev declarations, no runtime imports. The Creator entry is now reachable from two surfaces with identical launch semantics, and a deployment that hides mode selection sees the menu item disabled with its reason, not absent. The entry disposes with the conversation scope that binds `creatorDraft`, so the face reads the current binding rather than capturing one.

## Testing

`create-plugin-menu-item.client.spec.tsx` covers the enabled render, dismiss-before-start ordering, keyboard selection, and the loading/error/unavailable/missing-preset disabled states. `apply.client.spec.ts` drives the real composition: the `main` page declares `plugins.add.actions`, the contribution registers as `CreatePluginMenuItem` with id `create-plugin`, and invoking its injected face without ever loading the settings section starts one Creator session.
