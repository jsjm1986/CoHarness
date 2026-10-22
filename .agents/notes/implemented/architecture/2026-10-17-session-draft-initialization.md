# Agent Note: Session draft initialization behind a root event

Status: implemented

English | [中文](2026-10-17-session-draft-initialization.zh.md)

## Problem

New Session flows can prefill the composer without sending a message, following [upstream PR #5505](https://github.com/deepseek-ai/deepseek-harness/pull/5505) (`c222ea968b02`). The fork uses a textarea and `InputMachine`, editor-independent reference spans, separately owned attachments, and the per-session `dsh.conversation.chat` store. Prefill must target the Session retained by navigation, preserve an existing draft unless clearing is explicit, refuse a live submission, and write no Host event before the user sends.

## Decision

**Options travel with the navigation, not the Session lookup.** `IWorkspaces.startSession` accepts `StartSessionOptions` (`prompt`, `clearPreviousDraft`, `onFailure`); `UiWorkspace.startSession` forwards the same minus the failure observer, which the Workspace UI's notice channel owns. The Workspace runtime emits the root `conversation/draft-initialize` event inside `commitSessionNavigation`'s commit callback, addressed to the exact retained `sessionId` — a superseded navigation never emits, so a delayed create cannot write into the wrong composer.

**The chat store owns browser draft persistence.** The initialization listener checks the live shell's text when it has content, otherwise the decoded stored draft. An empty shell that has not restored the store does not make an existing draft replaceable. Clearing writes through `chat.actions.setDraft`, so remount cannot revive the cleared value. [Structured draft persistence](2026-10-18-structured-browser-draft-persistence.md) owns reference restoration and legacy string decoding. Attachments remain separately owned and unchanged by initialization.

**A live submission refuses first.** The listener and the `InputHub` apply path both check `adjudicating`/`submitting` before any write; refusal never clears the draft it declined.

**Shells that do not exist yet consume one pending initialization.** `InputHub.pendingInits` holds the resolved request per Session; `shellFor` consumes it before publishing the shell, so the first input-model read already carries the initialized draft — there is no React-effect restore window and no second persistence writer.

## Alternatives considered

**Import the upstream editor and its draft store.** Rejected: the textarea input machine already owns text and reference occurrences. The [editor-independent snapshot](../feature/2026-10-18-rc2-client-surface-parity.md) projects that state without adding another editor model; `startSession` callers still supply only `prompt?: string`.

**Emit the event at create time instead of navigation commit.** Rejected: a superseded or failed navigation would still have written a draft into a Session the user never landed on. Addressing the retained binding at commit is what bounds the write to the target.

**Let the React mount effect apply the prompt after seeding the stored draft.** Rejected: the mount effect restores persisted text into an empty input, so an explicit `clearPreviousDraft` would be silently undone by the very restore it was meant to supersede. Ownership moved to the store write itself.

## Consequences

`StartSessionOptions` is exported from the client runtime; `SessionInputResolver` gained `requestDraftInitialization` and the hub a non-creating `peek`. The catalog declares `conversation/draft-initialize` as a client-face event owned by the ui-conversation README. Callers without options see the unchanged New Session flow; a `prompt` is a prefill only and produces no `user/message` or `turn/start` until the user submits.

Regression coverage lives in `packages/client/runtime/tests/workspaces-service.client.spec.ts` (emit on commit, superseded navigation, `onFailure`), `packages/client/ui-conversation/tests/draft-initialization.client.spec.tsx` (prefill, preserve, clear, live-shell sync, submission refusal), and `apps/web/tests/draft-initialization.e2e.ts` (shipped composition: prefill across reload, Workspace reuse preserve/clear, untouched flow, no Host events before send).

## Testing

Workspace service tests cover committed and superseded navigation; conversation tests cover preserved and cleared drafts, submission refusal, and structured restore. The built-client browser scenario covers prefill and structured references across reload, Workspace reuse, and absence of Host messages before submission.
