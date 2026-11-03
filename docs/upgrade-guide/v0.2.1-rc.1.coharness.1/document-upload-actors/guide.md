---
kind: upgrade-guide
description: "Authenticated resumable uploads require their original actor and use owner-bound private manifests."
---

# Resume documents with the original uploader

English | [中文](guide.zh.md)

## Change

Authenticated upload sessions belong to the initiating user. Another writable project member cannot inspect, append, complete or cancel them, and a browser fingerprint only resumes the same user's session. Concurrent uploads reserve separate target names. Published documents retain their ordinary access policy.

Personal Gateway runtimes bind upload requests to their verified principal even without a collaboration plugin. Managed requests missing an uploader and project runtimes missing collaboration authority refuse upload creation; they do not create anonymous sessions.

Private manifests below `.upload-sessions/v1/` use format version 2 when bound to an actor. Earlier providers reject that version. Version 1 sessions remain ownerless; authenticated compositions refuse to adopt them because their uploader cannot be established. Completed references with document incarnation metadata use manifest version 3; versions 1 and 2 cannot represent that metadata. Upload status, transfer listings and copy results preserve validated identity fields. The browser rejects invalid completion references and mismatched byte counts. The public HTTP protocol remains `resumable-v1`.

Accepted `verifying` uploads remain recoverable after their receiving-session retention deadline. They retain their names and concurrency slots until completion, failure or authenticated cancellation; startup resumes interrupted verification. Browser polling has its own bounded wait. Cleanup requires a valid expiry record for a receiving or terminal session. Unknown, corrupt or oversized manifests fail cleanup while preserving their bytes; a missing manifest also retains its partial file for recovery. A compatible reader or original-manifest backup is required before those records can be reclaimed automatically.

## Migration

1. Stop older workers before a version 3 writer runs: earlier cleanup implementations can delete unknown manifests. Back up each document root, including `.upload-sessions/`, and upgrade the Gateway, `dsh-host-userdoc-http` and local document provider together.
2. Resume actor-bound sessions using the original account and scope. Another account receives `404 DOCUMENT_UPLOAD_NOT_FOUND`, even with project write access. Browser metadata cannot override the owner.
3. Reselect the source file to restart unfinished ownerless uploads under the authenticated account, including personal uploads made without collaboration. The browser discards stale resume metadata after HTTP 404. Its private partial bytes remain until the configured retention expires; if old receiving reservations fill the scope's concurrency limit, wait for expiry before retrying; allow accepted verification to finish or cancel it with its original authorized actor. Do not edit owners or identities into old manifests or lower version numbers. Restore a complete compatible backup for rollback.
4. With two writable project accounts, start the same filename and fingerprint. Confirm separate upload identifiers and names, complete both files, and verify their catalog ownership. Restart the service and confirm an incomplete upload still accepts only its initiating account.
