# Agent Note: Gateway local document broker

Status: implemented

English | [中文](2026-10-15-gateway-local-document-broker.zh.md)

## Problem

Documents are a standing product surface, but every scope-facing browser operation — listing, preview, upload, trash — was proxied into the scope's runtime process. Idle runtimes are reaped after thirty minutes, so opening a document panel paid a cold start, and a slow plugin could push startup past the readiness window and surface as an availability error. The coupling was architectural, not incidental: `userdoc-local` stores documents as ordinary files under `<mount>/documents/` with atomic-rename publication, yet the filesystem was reachable only through a running runtime's HTTP endpoint.

## Decision

The Gateway serves document routes itself through a `LocalDocumentBroker` (`gateway/src/documents-local.ts`). A personal scope resolves to the owner's `documents/` directory; a project scope resolves to `<projectPath>/documents` after `validateProjectRuntimePath`, the same containment check a runtime launch performs. Every request still passes the existing scope authorization — membership for reads, `rw` for writes, the administrator path for cross-user personal access — before any filesystem access.

Behavior parity comes from sharing code, not re-implementing it. `dsh-userdoc-local` exports `LocalUserDocFs`, the context-free filesystem engine the `LocalUserDocStore` service delegates to; the broker keeps one engine per document root and disposes them with the Gateway. `dsh-host-userdoc-http` exports `handleUserDocHttp` plus the `UserDocHttpHost`, `UserDocRequest`, and `UserDocResponse` adapter types, so the broker runs the literal runtime route table — list, directories, content, uploads, folders, move, trash, restore, purge — against each scope root. Content downloads stream into the live client response with the runtime's headers; JSON operations are answered through an in-memory response capture whose body passes the same path redaction the runtime applies.

The managed runtime selects the Gateway document provider and shares the broker-owned engine with browser requests. Signed request principals or captured executions establish current participants; catalog authorization returns exact publication revisions and trash actions. Identity metadata, upload actors and ordered delivery records remain outside runtime-writable mounts. Browser and runtime metadata notifications deliver this protected journal without supplying catalog facts. The receiving catalog commits each prefix before its private acknowledgement, and every change retains its original actor independently of the observer who triggers delivery. A real PostgreSQL/HTTP replay lets another member list a newly published upload before its uploader polls completion and verifies that the creation history names the uploader and advances the receiver checkpoint.

Routes retain their runtime-proxy fallback when the broker is absent. Snapshot copies stream through the same authorized storage owners, and opened source identity follows the content response into lineage recording. Standalone Host compositions retain their current-runtime provider.

Receiver cursor reads validate the retained root prefix before acknowledging it locally. A retry repairs a private acknowledgement interrupted after the catalog commit even when the receiver already holds the complete head; it neither resends those facts nor leaves the local outbox pending indefinitely. The compiled maintenance replay interrupts that acknowledgement through write admission, then verifies upload completion, writer drain and the absence of further cursor reads after recovery.

Runtime document reads, one-shot saves and chunk bodies retain an access-monitor subscription through response and source cleanup. Admission catches up before checking captured authority and rechecks the runtime generation; a relevant account, project or captured-participant invalidation cancels the transfer. Monitor loss refuses admission and cancels active transfers. Revocation acknowledgement waits for accepted transfer cleanup, and cleanup failure blocks that acknowledgement. A missing monitor refuses document-backend assembly. Actual PostgreSQL and raw HTTP observations preserve already-sent bytes, refuse a held download suffix and an unfinished save after membership removal, and retain the old applied revision until source cleanup is released. The cancelled save leaves no public file or catalog row. Browser upload requests use the same monitor through chunk input and response cleanup. Initial catch-up precedes fresh login validation; relevant changes during validation or body handling cancel the request. A response already closed during upload inspection supplies an aborted store signal, preventing a late chunk commit.

Durable access delivery closes cached owners removed from their account or project root. Accepted HTTP/catalog work drains before the filesystem engine closes and the revision is acknowledged. An in-progress open belongs to the same shutdown owner; a late authorization result must recheck current root ownership before creating storage. Lookup outages close the affected cache and refuse new opens until recovery without retaining a failed ownership query as an unresolvable cancellation. Failed shutdown still blocks acknowledgement.

Directory ownership is persisted independently of its pathname. Organization and immutable scope id select private metadata and upload storage. A replacement project imports active public files as new legacy identities with unknown creators; prior trash and unfinished uploads remain private byte archives. The former HTTP scope and filesystem engine drain before replacement opens. The ownership record commits its replacement and pending retirement together, and replay finishes the archive marker before admitting the current scope. Older project ids and unrelated account or organization owners cannot reclaim the directory. Existing path-only stores keep their identity only when a nonempty committed catalog prefix attests the requested scope. Retired archives preserve raw bytes and metadata for node-administrator retention; they are excluded from active identity rebinding during deployment restore. Each physical public directory belongs to at most one active identity domain; backups and restores refuse conflicting active owners.

Managed Web storage selection uses credential-channel markers inherited and captured before plugin activation. An unavailable Gateway or execution provider leaves managed document storage pending; it cannot select a local writer. Standalone storage selection is independent of later service publication and environment-file values.

## Alternatives considered

**Reuse private storage by directory path.** A new project is a new authority even when an administrator selects retained files. Sharing the former private namespace would expose previous trash and upload sessions and attach their ownership history to the new membership. Separate scope storage preserves the selected active-file import without granting access to those private records.

**Retry and timeout tuning.** A longer readiness window or request retry masks the cold start without removing it; a document operation would still depend on process availability, plugin health, and port allocation.

**Keep runtimes warm or pre-warm on login.** Trading memory for convenience inverts the architecture: documents are data, and pinning N runtime processes for N browsed scopes costs gigabytes to serve filesystem reads.

**A dedicated document daemon.** A shared per-scope document process would centralize the same filesystem access but adds a third process kind with its own lifecycle, port allocation, and failure modes. The Gateway already terminates document requests and knows every scope root, so the daemon's only contribution would be isolation the deployment does not need.

**Answer listings from `document_catalog` alone.** The catalog is a synchronized index, not the store; serving it directly would show stale rows, could not stream content, and would create a second read path with different semantics. The broker reads the real filesystem and uses the catalog only for the ownership and history duties it already owns.

## Consequences

Browsing, uploading, and lifecycle operations on any authorized scope complete without starting a runtime; the panel no longer exposes `INSTANCE_UNREACHABLE` for a scope whose runtime is merely asleep. Memory and cold-start cost move to zero for document-only visits, while slow project plugins stop being a document-availability dependency.

Gateway-managed mutations share the identity engine writer lock, exact version checks and recovery journal. Shell and filesystem edits remain ordinary public-file operations and are observed before subsequent document access. The broker preserves scope authorization and browser path redaction; its private metadata cannot be supplied by a runtime notification.

The [index pagination and trash lifecycle note](2026-08-27-document-index-pagination-and-trash-lifecycle.md) rejected catalog-only mutation without touching bytes; this broker preserves that ordering because it changes real files through the shared handlers before the catalog records the result. The [resumable upload note](2026-08-25-resumable-user-document-upload.md) protocol is unchanged — the Gateway speaks it against the local engine rather than streaming chunks onward to a runtime.

Verification covers scope listing without a runtime start, resumable upload through asynchronous verification, streamed content, personal and project authorization, catalog synchronization and ownership checks, administrator lifecycle access, transfer directory metadata, and broker disposal on shutdown.
