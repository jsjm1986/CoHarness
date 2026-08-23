# Agent Note: Attach existing documents from the manager

Status: implemented

English | [中文](2026-08-22-document-manager-attach-existing-documents.zh.md)

## Problem

The document manager and conversation composer use the same durable user-document store, but the manager exposed no action for reusing a document that was already stored. Users had to upload another browser file even when the document was available in the current scope.

## Decision

The conversation service exposes `IConversation.attachDocument(sessionId, ref)`. It creates a ready composer draft whose `docId` points at the supplied durable `UserDocRef`, then appends that draft id to the session input shell. The draft entry records whether it owns a browser-uploaded durable file. Browser uploads retain delete-on-remove behavior; manager attachments release only composer metadata and never delete the stored document.

The `ui-documents` plugin injects an `attachDocument` callback into its sidebar action. The callback reads the current session from `ctx.sessions.list`, delegates to `ctx.conversation`, and returns false when there is no current session, no conversation service, or the input shell is locked by submission. Each document row presents `加入对话` / `Add to conversation`; an accepted attachment closes the manager, while a rejected one keeps it open and shows localized failure copy. Reattaching the same durable `docId` to one session is idempotent.

The submitted prompt remains the existing `{ type: 'document', docId }` content part, so no new session event or model-visible input is introduced by the manager action itself.

## Alternatives considered

**Fetch the stored content into a browser `File` and upload it again.** Rejected because it duplicates durable storage, adds needless transfer and failure states, and makes removing the composer draft ambiguous.

**Have the manager reach into `InputBar` or dispatch a browser event.** Rejected because presentation components do not own cross-package context access; the conversation service is the existing service face for composer mutations.

**Persist a separate manager-attachment event.** Rejected because attaching a draft is browser-local state, and the existing document id is already logged when the user sends the message.

## Consequences

Stored documents can move from the manager into the active composer without re-upload. Removing such a draft no longer risks deleting a document that may be referenced by history. The action requires an active session and a composer that is not in an admission phase; the manager reports a localized failure when either condition is absent. The public conversation face gains one session-addressed mutation used by the document plugin.

## Verification

Conversation orchestration tests cover ready draft projection, durable-id preservation, idempotent attachment, and non-deletion on removal. Document-manager component tests cover the row action, successful close callback, and failure alert. Package and Web GUI checks cover the assembled action and localized copy.
