# Agent Note: Gateway local document broker

Status: implemented

English | [中文](2026-10-15-gateway-local-document-broker.zh.md)

## Problem

Documents are a standing product surface, but every scope-facing browser operation — listing, preview, upload, trash — was proxied into the scope's runtime process. Idle runtimes are reaped after thirty minutes, so opening a document panel paid a cold start, and a slow plugin could push startup past the readiness window and surface as an availability error. The coupling was architectural, not incidental: `userdoc-local` stores documents as ordinary files under `<mount>/documents/` with atomic-rename publication, yet the filesystem was reachable only through a running runtime's HTTP endpoint.

## Decision

The Gateway serves document routes itself through a `LocalDocumentBroker` (`gateway/src/documents-local.ts`). A personal scope resolves to the owner's `documents/` directory; a project scope resolves to `<projectPath>/documents` after `validateProjectRuntimePath`, the same containment check a runtime launch performs. Every request still passes the existing scope authorization — membership for reads, `rw` for writes, the administrator path for cross-user personal access — before any filesystem access.

Behavior parity comes from sharing code, not re-implementing it. `dsh-userdoc-local` exports `LocalUserDocFs`, the context-free filesystem engine the `LocalUserDocStore` service delegates to; the broker keeps one engine per document root and disposes them with the Gateway. `dsh-host-userdoc-http` exports `handleUserDocHttp` plus the `UserDocHttpHost`, `UserDocRequest`, and `UserDocResponse` adapter types, so the broker runs the literal runtime route table — list, directories, content, uploads, folders, move, trash, restore, purge — against each scope root. Content downloads stream into the live client response with the runtime's headers; JSON operations are answered through an in-memory response capture whose body passes the same path redaction the runtime applies.

Catalog integration runs through the same handlers the runtime calls: the broker's `gatewayRuntime` facade routes `sync`, `authorize`, `history`, `overview`, and directory callbacks to the Gateway's own PostgreSQL handlers, and mutation authority travels on signed principals issued per request with the live instance generation when one exists. Because the underlying store is plain files, a document published by the Gateway while a runtime runs is picked up on the runtime's next directory scan, and no write-order lock is needed beyond the engine's own atomic publication.

Every route retains its runtime-proxy fallback when the broker is not configured, and the in-runtime `/api/documents` serving for the active runtime is unchanged. The cross-scope snapshot copy still streams between runtime endpoints; only its listings, uploads, and directory metadata moved local.

## Alternatives considered

**Retry and timeout tuning.** A longer readiness window or request retry masks the cold start without removing it; a document operation would still depend on process availability, plugin health, and port allocation.

**Keep runtimes warm or pre-warm on login.** Trading memory for convenience inverts the architecture: documents are data, and pinning N runtime processes for N browsed scopes costs gigabytes to serve filesystem reads.

**A dedicated document daemon.** A shared per-scope document process would centralize the same filesystem access but adds a third process kind with its own lifecycle, port allocation, and failure modes. The Gateway already terminates document requests and knows every scope root, so the daemon's only contribution would be isolation the deployment does not need.

**Answer listings from `document_catalog` alone.** The catalog is a synchronized index, not the store; serving it directly would show stale rows, could not stream content, and would create a second read path with different semantics. The broker reads the real filesystem and uses the catalog only for the ownership and history duties it already owns.

## Consequences

Browsing, uploading, and lifecycle operations on any authorized scope complete without starting a runtime; the panel no longer exposes `INSTANCE_UNREACHABLE` for a scope whose runtime is merely asleep. Memory and cold-start cost move to zero for document-only visits, while slow project plugins stop being a document-availability dependency.

Concurrent writes from Gateway and runtime share one directory through the store's existing atomic-rename and manifest discipline; there is no cross-process lock, so a lost race fails cleanly with a naming collision instead of corrupting state. The broker must stay inside the same authorization, path-validation, and redaction rules as the proxy it replaces — the scope check remains the admission point, and `publicDocumentBody` keeps private paths out of browser JSON.

The [index pagination and trash lifecycle note](2026-08-27-document-index-pagination-and-trash-lifecycle.md) rejected catalog-only mutation without touching bytes; this broker preserves that ordering because it changes real files through the shared handlers before the catalog records the result. The [resumable upload note](2026-08-25-resumable-user-document-upload.md) protocol is unchanged — the Gateway speaks it against the local engine rather than streaming chunks onward to a runtime.

Verification covers scope listing without a runtime start, resumable upload through asynchronous verification, streamed content, personal and project authorization, catalog synchronization and ownership checks, administrator lifecycle access, transfer directory metadata, and broker disposal on shutdown.
