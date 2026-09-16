# Agent Note: Workspace files entry reaches the single-conversation header

Status: implemented

English | [中文](2026-09-16-session-header-workspace-files-entry.zh.md)

## Problem

The Workspace file browser shipped with the workbench registered its entry point only on `conversation.workbench.pane.header`, so the folder action existed inside grid panes but had no counterpart on the single-conversation surface. A hosted (non-loopback) single Session could preview files reached through `openFile` bounces, but had no way to open the browser itself — the Workspace files UI was effectively absent outside the workbench.

## Decision

The same `filesAvailable`/`openFiles` session binding is now contributed to `conversation.session.header.utilities` as `workspace-files`, rendered by `WorkspaceFilesAction`. The utilities seat is the session-scoped home for optional runtime utilities (open-in-app already lives there), so the control lands in the right-aligned utility group rather than the title-adjacent action row. While the viewport runs in workbench mode the entry returns `null`: every visible Session already sits inside a grid pane whose pane header carries the identical button, so rendering it in each pane's Session header would double the affordance. Availability keeps the pane header's rule — remote connection plus a `workspaceResources` provider for the Session's runtime target — so loopback desktops keep their native open-path behavior without a dead button.

## Alternatives considered

**Move the entry off the pane header entirely.** Rejected: the pane chrome is the workbench surface's compact action cluster, and relocating the control into each pane's Session header would change accepted workbench layout for no behavioral gain.

**Render in both seats unconditionally.** Rejected: workbench panes mount `conversation.session.header` too, so an unconditional entry would draw two folder buttons per pane.

## Consequences

Single conversations on hosted runtimes show the folder button in the Session header's utility group and open the same `WorkspaceFileBrowser` the workbench uses; workbench panes are unchanged. The store, browser, and preview plumbing are shared, so a browser opened from either surface routes to the Session's own runtime target.

## Verification

`workbench.client.spec.tsx` covers the button's render, click-through, workbench-mode suppression, and hidden states without provider or opener; `apply.client.spec.ts` asserts the utilities registration binds the same `filesAvailable`/`openFiles` pair and reports `inWorkbench` from the viewport snapshot.
