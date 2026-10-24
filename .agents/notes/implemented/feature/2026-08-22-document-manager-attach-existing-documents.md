# Agent Note: Attach existing documents from the manager

Status: implemented

English | [中文](2026-08-22-document-manager-attach-existing-documents.zh.md)

## Problem

The document manager and conversation composer use the same durable user-document store, but the manager exposed no action for reusing a document that was already stored. Users had to upload another browser file even when the document was available in the current scope.

## Decision

The conversation service exposes `IConversation.attachDocument(sessionId, ref)`. It creates a ready composer draft whose `docId` points at the supplied durable `UserDocRef`, then appends that draft id to the session input shell. The draft entry records whether it owns a browser-uploaded durable file. Browser uploads retain delete-on-remove behavior; manager attachments release only composer metadata and never delete the stored document.

The `ui-documents` plugin owns one document-picker host in `shell.overlay`. The host remains mounted when Workbench omits the sidebar footer. The sidebar Documents button requests management mode; each composer's library button requests selection mode with its explicit Session id. The host captures that destination Session and runtime when the request arrives, so a later focus change cannot redirect an attachment. Its opening-request listener leaves with the host.

The host receives an `attachDocument` callback that delegates to `ctx.conversation` with the captured Session. An absent destination, unavailable Session, missing conversation service, or locked input shell rejects attachment without falling back to another Session. Each document row presents `加入对话` / `Add to conversation`; an accepted attachment closes the manager, while a rejected one keeps it open and shows localized failure copy. Reattaching the same durable `docId` to one Session is idempotent.

The submitted prompt remains the existing `{ type: 'document', docId }` content part, so no new session event or model-visible input is introduced by the manager action itself.

## Alternatives considered

**Fetch the stored content into a browser `File` and upload it again.** Rejected because it duplicates durable storage, adds needless transfer and failure states, and makes removing the composer draft ambiguous.

**Have the manager mutate `InputBar` through context access or a browser event.** Rejected because the conversation service owns composer mutations. The browser event requests a picker opening; it does not attach a document.

**Persist a separate manager-attachment event.** Rejected because attaching a draft is browser-local state, and the existing document id is already logged when the user sends the message.

## Consequences

Stored documents can move from the manager into the captured composer without re-upload. Removing such a draft preserves the durable document, including references from history. The action requires a loaded Session and a composer that is not in an admission phase; the manager reports a localized failure when either condition is absent. Picker availability follows the root overlay's lifetime rather than the visibility of a sidebar action.

## Verification

Conversation orchestration tests cover ready draft projection, durable-id preservation, idempotent attachment, and non-deletion on removal. Document-manager component tests cover the row action, successful close callback, and failure alert. Package and Web GUI checks cover the assembled action and localized copy.
