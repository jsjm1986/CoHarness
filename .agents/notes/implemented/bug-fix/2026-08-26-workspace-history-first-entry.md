# Agent Note: Workspace entry opens history before new sessions

Status: implemented

English | [中文](2026-08-26-workspace-history-first-entry.zh.md)

## Problem

Entering a Workspace used the same blank-session reuse path as the explicit New Session action. A Workspace with existing conversations therefore opened an empty Hero instead of the conversation the user was continuing.

## Decision

`WorkspaceRuntime.openWorkspace()` selects the newest visible, non-blank, non-archived root Session from the existing Workspace and Session list snapshots. It performs no additional list request and falls back to `connectWorkspace()` when the Workspace has no eligible history. Startup and the Hero Workspace picker use this history-first entry; explicit New Session controls continue to use the blank-session path.

The Hero picker asks for confirmation when its current Session has unsent text, images, or documents. The confirmed path resolves the target first, then clears the browser-owned draft and releases its preview/upload resources before opening the target history. Cancellation and target failures leave the current Session and draft unchanged.

## Alternatives considered

**Change `connectWorkspace()` to history-first.** Rejected because sidebar New Session and Workspace plus actions rely on its blank reuse guarantee.

**Open the first manually ordered Session.** Rejected because continuing work follows the latest activity; Workspace order remains a separate presentation preference.

**Transfer an unsent Hero draft to the target Workspace.** Rejected for this flow because it hides the target's history and makes a draft appear as an implicit new conversation; the user explicitly confirms discard before switching.

## Consequences

Returning users land in the latest available conversation on both desktop and compact Web layouts. Empty Workspaces retain the existing blank Hero fallback, and explicit New Session remains predictable. The history choice is an in-memory O(n) scan over already loaded summaries, so it adds no model call or extra list request. A confirmed Hero draft is intentionally discarded and its browser resources are released; cancellation preserves it.

## Verification

Runtime tests cover newest-history selection, blank/archived/subagent exclusion, fallback creation, and startup behavior. Conversation tests cover the confirmation, cancellation, failure rollback, and confirmed cleanup paths. The assembled Web scenario covers desktop and 390px startup history, plus explicit New Session blank entry; snapshots pin the rendered conversation state.
