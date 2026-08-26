# Agent Note: Keep repeated project-scope reloads cheap

Status: implemented

English | [中文](2026-08-26-project-scope-switch-performance.zh.md)

## Problem

Project-scope changes keep independent runtimes and reload the Web page. Each reload can ask the same warm runtime for the same conversation-detail history tail. The Host copied and paginated the resident event log for every such request, even when the append log and presenter registrations were unchanged. The Gateway account context also queried project details once per membership row after the membership query had already established the authorized set.

## Decision

The Host ApiProxy keeps a bounded per-runtime LRU of Web `detail: 'conversation'` tail responses. An entry is valid only for the same attached/detached source, session append-log identity, requested `maxMessages`, and projection registration revision; detached entries additionally require the persistence revision, so a repeated cold read can validate the cache without loading the full event log. The value is cloned on write and read, limited to 16 entries and 2 MiB of JSON, and discarded on session events, session disposal, tool-registry changes, or projection-key changes. `beforeSeq` pages and `detail: 'full'` requests retain the existing uncached path; the history wire value and pagination rules do not change.

The projection registry exposes a monotone registration-set revision. It changes only when a projection key enters or leaves the registry, so a cached history block cannot outlive the set of keys that can appear in that block.

The Gateway context endpoint reads the project catalog once and maps the already-authorized membership rows to owner flags. Legacy in-process catalog rows that omit owner metadata retain a detail fallback; production rows include it and stay on the one-read path. `projectForUser` applies the requested project id inside its PostgreSQL query instead of scanning every project authority row. Authorization output, membership semantics, and scope cookies remain unchanged.

The frontend static server marks Vite-style hashed files under `/assets/` as immutable for one year. The HTML entry and non-hashed files keep their existing response headers, so release selection and index injection remain unchanged.


## Alternatives considered

**Replace the independent runtime and full reload with a hot scope connection.** Rejected for this change because it would alter process isolation, connection ownership, draft lifetime, and failure handling. The existing scope handoff remains the authority.

**Read only a PostgreSQL history tail in this change.** Deferred because message-boundary pagination, replacement provenance, preset reconstruction, and projection cuts need a separate persistence/read-model contract. The cache removes repeated warm-runtime work without changing any of those semantics.

**Keep an unbounded history cache.** Rejected because project runtimes can serve many sessions and a single large tool result can make one page large. The LRU byte and entry limits bound retained memory, and cloning prevents callers from mutating the retained value.

## Consequences

Repeated reloads that target an unchanged warm session avoid the Host-side history copy, pagination scan, and presenter pass; repeated cold reads also avoid reloading the full detached event log after a lightweight persistence revision check. Hashed frontend assets survive those reloads in the browser or CDN cache. The first read of a cold or changed log still uses the existing full-log inspection and presentation path, with only the metadata revision probe added for cache safety. Cache invalidation is conservative, so a stale projection or tool view is not served across a registry or event change. Project context construction uses one catalog read rather than one detail read per authorized project while returning the same rows and management flags; only legacy rows without owner metadata use the old detail fallback. No durable format, wire schema, permission rule, runtime isolation rule, or page-reload behavior changes.

Focused ApiProxy, projection-registry, Gateway, and collaboration tests cover the cache invalidation and context behavior; the cache remains an optimization and all misses use the existing history implementation.
