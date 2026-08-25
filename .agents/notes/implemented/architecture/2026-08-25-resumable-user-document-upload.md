# Agent Note: Resumable user-document uploads

Status: implemented

English | [中文](2026-08-25-resumable-user-document-upload.zh.md)

## Problem

The public Web UI sent every selected document as one HTTP request. The production Cloudflare entry limits one request body to roughly 100 MB, so a 100.23 MB document was terminated at the edge before the runtime could publish it. Mobile and desktop clients shared the same failure, and the browser reduced the interrupted request to a generic upload error.

## Decision

The user-document seam now uses a versioned `resumable-v1` upload session for every browser upload. The client creates or resumes a session, sends sequential bounded raw chunks, supplies a SHA-256 digest for each chunk, and submits a final digest. The local provider persists a private manifest and partial file below `.upload-sessions/v1/`, verifies the complete file, and publishes the ordinary document reference atomically only after verification. The browser stores only opaque session metadata and can resume after the user reselects the same file; incomplete sessions expire after the configured 24-hour default.

The protocol keeps file bytes in runtime-owned directories and does not add a database migration. A provider advertises its chunk size and session retention through `UserDocLimits.upload`; the default chunk is 8 MiB. The provider does not impose a business single-file quota, but it reserves configured disk headroom and limits active sessions. The old one-request `POST /api/documents` route no longer writes and returns `UPLOAD_PROTOCOL_REQUIRED`, so frontend and Gateway releases are cut over together.

The conversation composer and document manager consume one shared browser uploader package. The Gateway document-copy broker uses the same session protocol instead of forwarding a whole source response into one request. Chunk and status requests are omitted from per-request API audit rows; upload lifecycle outcomes remain observable without flooding the audit log.

The nullable per-file admission default and connection-interruption wording remain governed by the [unlimited-upload decision](../bug-fix/2026-08-22-unlimited-document-upload.md).

## Alternatives considered

**Increase or remove the Cloudflare limit.** This would preserve one-request uploads but would not provide retry or resume behavior and would leave mobile uploads vulnerable to connection loss. The application must work across deployments whose ingress limit is not controlled by the runtime.

**Store document bytes in R2/S3.** Object storage would provide a separate scalable transport, but it would add credentials, signed URL ownership, lifecycle policy, and a second durable storage model. Runtime-owned files are an existing product contract and remain the provider boundary.

**Keep separate composer and manager upload implementations.** Two state machines would drift in retry, checksum, and resume behavior. A browser-only shared package keeps the wire protocol and recovery behavior identical while each UI supplies its own HTTP error adapter.

**Keep the legacy one-request endpoint indefinitely.** A permanent second write path would preserve the same ingress failure and double the security and test surface. The release performs an explicit protocol cutover; a mismatched cached client receives a refreshable protocol error.

## Consequences

Each chunk consumes one public request and one bounded browser buffer, so files larger than the ingress body limit can complete and transient network failures retry without restarting the file. Finalization has a short asynchronous verification state, which keeps the public request from waiting on a large-file hash. Temporary manifests add filesystem entries and cleanup work, and deployments must configure disk headroom and concurrent-session safety. Session records expire after the configured retention, while published documents retain the existing manual deletion policy.
