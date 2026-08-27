# Agent Note: Document index pagination and recoverable trash

Status: implemented

English | [中文](2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md)

## Problem

Large document workspaces made a complete runtime scan and browser-side filtering expensive. Deletion also had no durable recovery window: a file removed from a runtime could disappear before an administrator or user corrected the mistake, and the organization catalog could not distinguish recoverable removal from permanent cleanup.

## Decision

The user-document service exposes bounded directory and trash pages with validated filters, stable ordering, and opaque continuation cursors. The Host and Gateway forward page parameters and never expose runtime paths; the Web manager uses cursor pages when a provider advertises them and keeps a local fallback for older providers. Already fetched pages remain available while the manager stays mounted, and changing a filter starts a new cursor chain.

Deletion moves a regular file into a provider-owned hidden trash store. A versioned manifest retains the original document id, display metadata, deletion time, and purge deadline. Restore recreates a missing original directory and resolves a non-overwriting target, while purge is explicit or runs after the configured retention period. Runtime routes expose list, restore, and purge operations with the same scope authorization as active documents.

The PostgreSQL catalog mirrors the lifecycle with `active`, `trash`, and `purged` states, retention timestamps, actor fields, and append-only `restored`/`purged` history. Existing `deleted` rows migrate to `trash` with the default 30-day deadline. Administrator APIs provide cursor listing and single or batch trash, restore, and purge actions; runtime bytes are changed before the catalog transition when the Gateway broker is available.

Migration 018 qualifies document-catalog user foreign keys with `organization_id`, including ownership, operation actors, and history actors, so imported UUIDs cannot cross organization ownership or audit records. It also adds active modified-time and trigram indexes used by the SQL-level overview filters and pages.

## Alternatives considered

**Keep complete listings and page only in the browser.** Rejected for providers that support the page contract because the response size and metadata work grow with the workspace; it remains the compatibility fallback for older providers.

**Delete files immediately and retain catalog metadata only.** Rejected because metadata cannot restore bytes after an accidental removal. The provider trash owns the bytes until the deadline, while the catalog remains an audit projection.

**Let administrators mutate catalog state without contacting the runtime.** Rejected because the UI would report recovery while the file stayed deleted, or report purge while bytes remained readable. The Gateway broker performs the runtime operation first and the catalog records the result.

## Consequences

Document list and search traffic is bounded by the requested page for current folders and all-scope metadata. Cursors are tied to one query chain and cannot be reused as a filesystem path. Providers without an index may still scan the selected directory to produce a page, but repeated in-flight reads are coalesced and recursive prompt listing remains a separate operation.

Trash consumes storage during its retention window and requires a maintenance sweep. A runtime or catalog outage can leave a pending reconciliation, so user-facing failures remain retryable and administrator actions report per-row results. Permanent purge removes the provider bytes and preserves catalog history without making the document readable again.

## Verification

Local provider tests cover manifest persistence, restore collisions, idempotent purge, and restart recovery. Host and Gateway tests cover bounded pages, path-free metadata, inline preview responses, scope authorization, stream forwarding, and lifecycle error mapping. Client tests cover cursor navigation, filter reset, mounted-page reuse, trash recovery, and mobile controls. PostgreSQL migration and catalog integration tests cover state conversion, retention columns, indexes, and audit history when `HGW_TEST_DATABASE_URL` is configured.
