# Agent Note: Resumable user-document uploads

Status: implemented

English | [中文](2026-08-25-resumable-user-document-upload.zh.md)

## Problem

The public Web UI sent every selected document as one HTTP request. The production Cloudflare entry limits one request body to roughly 100 MB, so a 100.23 MB document was terminated at the edge before the runtime could publish it. Mobile and desktop clients shared the same failure, and the browser reduced the interrupted request to a generic upload error.

## Decision

The user-document seam now uses a versioned `resumable-v1` upload session for every browser upload. The client creates or resumes a session, sends sequential bounded raw chunks, supplies a SHA-256 digest for each chunk, and submits a final digest. The local provider persists a private manifest and partial file below `.upload-sessions/v1/`, verifies the complete file, and publishes the ordinary document reference atomically only after verification. The browser stores only opaque session metadata and can resume after the user reselects the same file; receiving sessions expire after the configured 24-hour default.

The protocol keeps file bytes in runtime-owned directories and does not add a database migration. A provider advertises its chunk size and session retention through `UserDocLimits.upload`; the default chunk is 8 MiB. The provider does not impose a business single-file quota, but it reserves configured disk headroom and limits active sessions. The old one-request `POST /api/documents` route no longer writes and returns `UPLOAD_PROTOCOL_REQUIRED`, so frontend and Gateway releases are cut over together.

The conversation composer and document manager consume one shared browser uploader package. The Gateway document-copy broker uses the same session protocol instead of forwarding a whole source response into one request. Chunk and status requests are omitted from per-request API audit rows; upload lifecycle outcomes remain observable without flooding the audit log.

The first verification status read starts immediately; subsequent reads retain the polling delay, expiry and deadline. Small files can finish verification before the completion response reaches the browser, so an initial delay adds no protection against sustained polling. The document manager owns one sequential batch at a time and captures its destination. Published counts describe durable results without merging returned references into filtered directory pages. A failure retains published files, stops unstarted siblings and revalidates the visible listing; progress and list responses from an older view cannot replace the current view.

Publication after a view change marks metadata stale while retaining the current view's continuation pages and pending scope confirmation. Dropping a visible page's predecessor without replacing its listing would leave a working Next control with no cursor to request.

Authenticated upload authority belongs to the initiating participant, independently of shared-project write membership. The server supplies a branded owner outside browser metadata; every session operation checks it before mutation, expiry cleanup or finalizer cancellation. Actor-bound manifests require format version 2, which an older reader refuses. Version 1 sessions remain ownerless and cannot be adopted by an authenticated actor, because the manifest contains no evidence of its original uploader. Fingerprint reuse includes the actor, while the admission lock reserves active target names and enforces a single root-wide resource budget.

Personal Gateway runtimes obtain the HTTP uploader from their verified request principal when no collaboration provider is mounted. A managed project whose collaboration authority disappears while upload metadata is read refuses creation rather than writing an ownerless session. Missing personal request authority also refuses every upload-session operation. Ownerless HTTP sessions remain available only without either identity service; existing ownerless records are not adopted.

The nullable per-file admission default and connection-interruption wording remain governed by the [unlimited-upload decision](../bug-fix/2026-08-22-unlimited-document-upload.md).

The Gateway owns a separate maintenance writer for each admitted background operation: initialization, upload verification and publication, expired-session cleanup and trash retention. HTTP response completion does not release a finalizer's writer. Refused admission precedes its filesystem writes and preserves the durable verifying state for a later status request or restart. A backup's quiescence decision must include these writers even when all model runtimes are stopped.

Completed publications that carry a document incarnation use upload manifest version 3 so readers cannot silently erase that version when resuming. Gateway and Host projections preserve validated identity fields while removing private paths; the browser accepts completion only with a valid reference and matching byte counts. Identity metadata records the original publication actor and origin, while current authorization remains independently required. The browser imports the pure `/identity` entry; the client bundle rejects the document service and other subpaths.

Accepted verification is durable work rather than an idle receiving session. Its manifest retains bytes, target name and concurrency ownership until publication, failure or authenticated cancellation. Cleanup preserves that state across instances and startup resumes it after a process stop, even when the receiving deadline has passed. Browser verification uses its own five-minute wait budget; the receiving timestamp does not shorten it.

An unreadable manifest provides no evidence of an expiry deadline. Cleanup preserves its bytes instead of treating parse refusal as permission to delete. Missing manifests retain orphaned partials for recovery; invalid, unknown and oversized manifests fail explicitly. Every cleanup worker settles before the admission lock and maintenance writer are released, retaining independent failures.

## Alternatives considered

**Increase or remove the Cloudflare limit.** This would preserve one-request uploads but would not provide retry or resume behavior and would leave mobile uploads vulnerable to connection loss. The application must work across deployments whose ingress limit is not controlled by the runtime.

**Store document bytes in R2/S3.** Object storage would provide a separate scalable transport, but it would add credentials, signed URL ownership, lifecycle policy, and a second durable storage model. Runtime-owned files are an existing product contract and remain the provider boundary.

**Keep separate composer and manager upload implementations.** Two state machines would drift in retry, checksum, and resume behavior. A browser-only shared package keeps the wire protocol and recovery behavior identical while each UI supplies its own HTTP error adapter.

**Refresh or append directory rows after every file.** Repeated reads multiply batch traffic, while appending references bypasses server filters and cursor ordering. A published-count summary exposes completed work; one authoritative reconciliation settles the listing.

**Keep the legacy one-request endpoint indefinitely.** A permanent second write path would preserve the same ingress failure and double the security and test surface. The release performs an explicit protocol cutover; a mismatched cached client receives a refreshable protocol error.

## Consequences

A received-byte count is acknowledged only after every byte is written and synchronized. Direct saves and resumable writes share a writer that advances by the syscall’s actual byte count, rejects zero progress and checks cancellation between writes. Failed partial chunks keep their previous durable progress so a retry rewrites the same range; a failed direct save removes its unpublished partial.

Each chunk consumes one public request and one bounded browser buffer, so files larger than the ingress body limit can complete and transient network failures retry without restarting the file. Finalization has a short asynchronous verification state, which keeps the public request from waiting on a large-file hash. Temporary manifests add filesystem entries and cleanup work, and deployments must configure disk headroom and concurrent-session safety. Receiving and terminal records expire after the configured retention; accepted verification remains recoverable until it settles, while published documents retain the existing manual deletion policy.
