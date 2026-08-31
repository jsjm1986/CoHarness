# Agent Note: Explicit Workspace New Session intent

Status: implemented

English | [中文](2026-09-01-explicit-workspace-new-session.zh.md)

## Problem

Selecting a Workspace intentionally opened its latest history, but the only visible creation affordance was easy to miss because the Workspace-row plus appeared on hover. A newly reserved blank Session could also disappear from the intended group while the Host list was catching up, making the next action look like it had not created a conversation.

## Decision

Keep Workspace selection history-first and expose New conversation as a separate action. Real Workspace rows keep their plus affordance visible, and the Hero exposes the same action beside the Workspace selector. Both actions call the existing `startSession` → `connectWorkspace` path, which reuses one compatible blank Session or creates one reservation.

The Session list keeps a client-local `workspaceId` hint for a newly reserved blank draft until the Host reports membership or the first visible event. The hint is used only for grouping and current-group expansion; it is removed on engagement or removal and is never serialized, searched, or persisted as Workspace membership. Repeated gestures remain coalesced by the existing Workspace single-flight and draft reservation.

## Alternatives considered

**Make Workspace selection create a blank Session.** Rejected because it hides the most recent conversation and changes the established history-first entry semantics.

**Persist every empty click as a new Session.** Rejected because abandoned rows accumulate and repeated clicks create ambiguous conversations.

**Show the plus only on hover.** Rejected because creation is not discoverable on desktop and is inconsistent with the always-available mobile affordance.

**Allow multiple blank drafts per Workspace.** Rejected because one reusable reservation is sufficient and avoids abandoned placeholders.

## Consequences

Users can open existing history and start another conversation from the same Workspace without changing modes or guessing where the action is. The extra grouping hint is bounded to the in-memory client list and disappears at the first durable content edge; it does not alter the Session wire contract, persistence format, Workspace membership, or search results. The existing one-draft reuse and single-flight behavior continue to prevent duplicate empty Sessions.

## Verification

Client runtime, Workspace tree, and ConversationRoot tests cover blank-draft retention, hinted grouping, explicit Hero activation, and first-message hint removal. The GUI suite and TypeScript typecheck pass. The assembled Web history-entry scenario remains history-first and exercises the explicit New Session path on desktop and compact layouts.

## Related

- [Workspace entry opens history before new sessions](2026-08-26-workspace-history-first-entry.md) — history-first selection remains authoritative; this note adds the separate creation intent.
- [Deferred session drafts and authoritative content watermarks](../architecture/2026-08-26-session-draft-lifecycle-and-content-watermarks.md) — durable draft reservation and visible-content promotion remain unchanged.
