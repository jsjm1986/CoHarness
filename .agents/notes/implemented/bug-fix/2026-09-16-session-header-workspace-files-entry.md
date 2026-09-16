# Agent Note: Workspace files entry reaches the single-conversation header

Status: implemented

English | [中文](2026-09-16-session-header-workspace-files-entry.zh.md)

## Problem

The Workspace file browser shipped with the workbench registered its entry point only on `conversation.workbench.pane.header`, so the folder action existed inside grid panes but had no counterpart on the single-conversation surface. A hosted (non-loopback) single Session could preview files reached through `openFile` bounces, but had no way to open the browser itself — the Workspace files UI was effectively absent outside the workbench.

## Decision

`WorkbenchToolbar` now advertises file browsing itself: a `filesAvailable`/`openFiles` inject pair renders the same folder icon button in the toolbar's action group. The toolbar already mounts on every conversation surface — as the grid's top row in workbench mode and as the Session header's `leading` seat in the single-conversation view — so one registration covers both. The toolbar binding resolves the addressed Session at call time: the active pane in workbench mode, `sessions.list.current` otherwise, then shares the pane header's availability rule — remote connection plus a `workspaceResources` provider for that Session's runtime target — so loopback desktops keep their native open-path behavior without a dead button. The per-pane header button stays as the direct per-pane control; the toolbar entry is the surface-level counterpart the shipped e2e contract already described.

## Alternatives considered

**Register a second entry on `conversation.session.header.utilities`.** Rejected: the session header mounts inside every workbench pane too, so an unconditional entry would double the affordance per pane, and suppressing it on `mode === 'workbench'` adds a mode predicate the toolbar placement does not need.

**Toolbar entry bound to a fixed Session.** Rejected: the toolbar outlives session switches, so the binding resolves the active Session at call time rather than capturing one at inject time.

## Consequences

Single conversations on hosted runtimes show the folder button in the workbench toolbar seat inside their Session header and open the same `WorkspaceFileBrowser` the workbench uses; workbench panes are unchanged. The store, browser, and preview plumbing are shared, so a browser opened from either surface routes to the addressed Session's own runtime target.

## Verification

`workbench.client.spec.tsx` covers the toolbar button's render, click-through, and hidden states without provider or opener; `apply.client.spec.ts` asserts the toolbar inject resolves the active pane Session in workbench mode and the current Session in single mode; `apps/web/tests/workspace-files.e2e.ts` drives the real browser through the toolbar button to a live preview.
