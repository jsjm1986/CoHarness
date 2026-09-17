# Agent Note: Hero workspace row keeps only the Workspace selector

Status: implemented

English | [中文](2026-09-17-hero-workspace-row-simplification.zh.md)

## Problem

The Hero workspace row accumulated four controls, two of which fought each other: a New conversation button duplicating the state the Hero already is — its composer is the blank-draft affordance — and a folder glyph on the Workspace chip sitting directly beside the Workbench toolbar's file-browser folder, so two identical icons with different meanings read as one confused file action.

## Decision

The Hero workspace row carries only navigation and scope controls: the workbench-leading slot, the Workspace chip, the workspace picker, and the agent-preset slot. The chip's icon is a new stacked-diamonds `IconWorkspaceOutline16` — a scope/layers metaphor — replacing the folder so the chip no longer collides with the adjacent files button or reads as a file action. Explicit session creation stays on the sidebar entry and each Workspace row's plus affordance, both still routed through `startSession` → `connectWorkspace`. The `ConversationInjected.newSession` member is removed with its only consumer.

## Alternatives considered

**Keep the Hero button.** Rejected: on the Hero the button can only re-resolve the same blank session the composer already represents, and the surviving entries cover fresh-session needs from elsewhere.

**Keep the folder glyph.** Rejected: two adjacent folder icons (Workbench files and Workspace chip) make both look like the same file action.

**Reuse an existing non-folder icon.** Rejected: no icon in the set carries a Workspace-scope meaning — panel-left is the sidebar toggle, and the data, plan, and skill glyphs belong to other features.

## Consequences

New-conversation intent on the Hero has exactly one expression — the composer — and the chip's layers glyph visually separates scope selection from file browsing. Session creation paths, draft reservation, and the `workspaceId` grouping hint are unchanged. Upstream still uses the folder icons, so the glyph is a deliberate divergence owned by the fork's extra Workbench controls.

## Verification

Conversation and ui-primitives typecheck pass; the lifecycle-chrome and agent-preset-selection Hero goldens are re-recorded without the button; the assembled Web scenario still enters history-first.

## Related

- [Explicit Workspace New Session intent](2026-09-01-explicit-workspace-new-session.md) — its Hero-affordance part is superseded here; the Workspace-row plus, history-first selection, and hint machinery still stand.
