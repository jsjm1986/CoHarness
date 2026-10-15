# Agent Note: Session draft initialization behind a root event

Status: implemented

English | [中文](2026-10-17-session-draft-initialization.zh.md)

## Problem

Upstream PR #5505 (`c222ea968b02`) widened `startSession(workspaceId?, options?)` with `prompt` and `clearPreviousDraft` so New Session flows can prefill a composer draft without sending it, and it made the structured draft store the initialization owner. The local composer is a textarea plus `InputMachine` with a plain-text draft, attachments tracked beside it, and a per-session chat store (`dsh.conversation.chat`) mirroring the draft for persistence — none of upstream's Lexical/structured-chip machinery exists to copy. The contract worth porting is the user-visible one: prefill lands only on the Session the navigation retained, an existing draft is preserved unless clearing is explicit, a live submission refuses the change, and nothing reaches the Host log before the user sends.

## Decision

**Options travel with the navigation, not the Session lookup.** `IWorkspaces.startSession` accepts `StartSessionOptions` (`prompt`, `clearPreviousDraft`, `onFailure`); `UiWorkspace.startSession` forwards the same minus the failure observer, which the Workspace UI's notice channel owns. The Workspace runtime emits the root `conversation/draft-initialize` event inside `commitSessionNavigation`'s commit callback, addressed to the exact retained `sessionId` — a superseded navigation never emits, so a delayed create cannot write into the wrong composer.

**The chat store stays the single durable draft owner.** The ui-conversation listener resolves the existing draft as the live shell's text when it holds one, else the persisted store value — an empty shell not yet seeded from the store does not make a preserved draft adoptable. Clearing writes through `chat.actions.setDraft`, so a cleared draft cannot re-seed at the next mount, and a prefilled one survives remount and reload. Attachments are untouched in every arm.

**A live submission refuses first.** The listener and the `InputHub` apply path both check `adjudicating`/`submitting` before any write; refusal never clears the draft it declined.

**Shells that do not exist yet consume one pending initialization.** `InputHub.pendingInits` holds the resolved request per Session; `shellFor` consumes it before publishing the shell, so the first input-model read already carries the initialized draft — there is no React-effect restore window and no second persistence writer.

## Alternatives considered

**Port upstream's structured `DraftSnapshot` and chip restoration.** Rejected: the local input is a textarea machine; the structured model belongs to a different editor architecture, and plain `prompt?: string` is the only part upstream exposes to `startSession` callers anyway.

**Emit the event at create time instead of navigation commit.** Rejected: a superseded or failed navigation would still have written a draft into a Session the user never landed on. Addressing the retained binding at commit is what bounds the write to the target.

**Let the React mount effect apply the prompt after seeding the stored draft.** Rejected: the mount effect restores persisted text into an empty input, so an explicit `clearPreviousDraft` would be silently undone by the very restore it was meant to supersede. Ownership moved to the store write itself.

## Consequences

`StartSessionOptions` is exported from the client runtime; `SessionInputResolver` gained `requestDraftInitialization` and the hub a non-creating `peek`. The catalog declares `conversation/draft-initialize` as a client-face event owned by the ui-conversation README. Callers without options see the unchanged New Session flow; a `prompt` is a prefill only and produces no `user/message` or `turn/start` until the user submits.

Regression coverage lives in `packages/client/runtime/tests/workspaces-service.client.spec.ts` (emit on commit, superseded navigation, `onFailure`), `packages/client/ui-conversation/tests/draft-initialization.client.spec.tsx` (prefill, preserve, clear, live-shell sync, submission refusal), and `apps/web/tests/draft-initialization.e2e.ts` (shipped composition: prefill across reload, Workspace reuse preserve/clear, untouched flow, no Host events before send).

## Testing

`packages/client/runtime`: workspaces suite — 52 tests. `packages/client/ui-conversation`: full suite — 714 tests. `apps/web` (built client bundle): `draft-initialization.e2e.ts` — 3 tests through the real Loader composition.
