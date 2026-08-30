# Agent Note: Web pending-submission echoes converge by request identity

Status: implemented

English | [中文](2026-08-30-web-pending-submission-echo.zh.md)

## Problem

Image submission used to wait for browser encoding before the conversation could render anything. A slow codec therefore made the send gesture appear lost, while a queue frame and its later durable `user/message` could render the same prompt twice. Browser object URLs also had no single owner once a durable image reference replaced a draft preview.

The existing [Web multimodal image input and durable attachments](2026-07-22-web-multimodal-image-input-and-durable-attachments.md) decision still owns durable image storage, admission ordering, and historical image rendering. This note adds the transient submission lifecycle that connects that durable boundary to the Web conversation.

## Decision

`Session.beginSubmission()` registers a local echo synchronously before image serialization and returns a fresh `rpcId`. The caller passes that identity to `session.prompt()` or `subagent.prompt()`. Host/API projection carries the same identity on the durable user-message source and on each `session/queue` occurrence; the queue schema preserves the occurrence field instead of stripping it.

`Session` keeps pending echoes outside the Session log. A durable `user/message` or queue occurrence schedules retirement on the next frame, and a settlement latch makes duplicate observations idempotent. Admission failures, serialization failures, cancellation, and session disposal retire the echo as failed. The caller receives the retirement callback exactly once and can restore failed drafts without confusing an uncommitted echo with durable history.

`ConversationController` gives the Chat view the browser-owned preview URL immediately. On observed image admission it transfers each preview to the session-scoped durable image cache, where the preview remains synchronously readable until the authenticated bytes resolve. The canonical URL then replaces it and the preview is revoked. Failed or invalidated loads remove the cache entry; releasing a rendered session revokes any current preview immediately and also releases a later canonical URL. Document-only and image-only prompts omit empty text blocks, and concurrent submissions settle only their own images.

Pending echoes are not reused as durable message nodes: durable renderers carry participant attribution, source event positions, and replay semantics that a local echo does not have. The echo is therefore a separate view-only projection that disappears when its request identity is observed.

## Verification

Focused runtime, queue-schema, ConversationController, ChatView, and MessageImage tests cover slow encoding, request-id forwarding, queue/durable duplicate observations, business/transport/abort failures, serialization abandonment, image-only and document-only content, concurrent submissions, durable URL replacement, failed-load retry, and preview cleanup on session release and disposal.

## Alternatives considered

**Render only after serialization and prompt admission.** Rejected because slow image encoding hides the user's send action and prevents immediate feedback.

**Deduplicate by message text or MessageId.** Rejected because identical prompts are valid separate submissions and a queue occurrence has its own identity before a durable message exists.

**Write pending echoes into the Session log.** Rejected because an unaccepted prompt is not model-visible durable history and would require rollback records, replay filtering, and new format semantics.

**Let each image component own preview-to-durable handoff.** Rejected because URL ownership, session authorization, retry cleanup, and concurrent submission isolation belong to the ConversationController's session-scoped cache.

## Consequences

Users see one local prompt immediately and one durable prompt after admission, with no duplicate during the observation overlap. Failed submissions keep browser drafts available for retry, while successful image submissions release previews only after the Host has acknowledged the durable or queued representation. The Session log and model-visible content remain unchanged by the transient projection.

The implementation is covered by jsdom and object-layer tests. Cross-browser codec performance, real Gateway stream timing, and production memory profiling remain release validation work; they are not implied by the local test suite.
