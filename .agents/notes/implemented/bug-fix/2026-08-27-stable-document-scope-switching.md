# Agent Note: Stable document scope switching

Status: implemented

English | [中文](2026-08-27-stable-document-scope-switching.zh.md)

## Problem

A cold or busy project runtime can make scope listing wait through Gateway authorization, runtime readiness, and bounded retries. Re-requesting a recently fetched listing on every scope visit makes this expected latency visible even when the manager already holds usable metadata. A runtime listing can also arrive before account context identifies its owning scope, so assigning or discarding it at response time risks either cross-scope cache pollution or a missed cache entry.

## Decision

The Documents manager keeps the last committed listing visible while a scope, directory, page, or refresh read is in flight. A lightweight refreshing state identifies the pending target; blocking skeletons are used only before the first listing is available. Every listing operation owns an `AbortController` and increments request generations; starting a newer operation aborts the previous one and late responses cannot publish.

Current and alternate scope reads share a bounded in-memory metadata cache keyed by scope, directory, filters, and sort. An entry is fresh for 30 seconds and serves the switch without another list request. An entry remains usable for five minutes: stale entries render immediately while a background request revalidates them, and failed revalidation keeps those rows while exposing the error. Expired entries are removed. Explicit refreshes and document mutations invalidate listing caches. The cache belongs to the mounted manager, contains no document bytes, and is not persisted to browser storage.

The initial runtime listing remains request-owned until account context confirms its scope. Both cursor pages and legacy non-paged responses settle into the scope-qualified cache after confirmation; an unavailable context leaves the temporary listing usable only by that active request. Reopening the manager refreshes account context without discarding a fresh listing, and an identity change loads the new runtime rather than retaining metadata from the former active scope.

Gateway-selected scope metadata forwarding uses `HGW_UPSTREAM_TIMEOUT_MS`. A stalled upstream returns `DOCUMENT_SCOPE_TIMEOUT` with HTTP 504 and releases its runtime lease. Successful document content streams are exempt from the metadata deadline and keep the lease through EOF or cancellation.

## Alternatives considered

**Always replace rows with a skeleton during a read.** Rejected because a runtime readiness delay is expected for a cold project and hiding a valid committed result turns a wait or recoverable error into a blank panel.

**Prewarm every project runtime when the manager opens.** Rejected because organizations can expose many projects and eager startup would consume processes and resources for scopes the user may never open.

**Rely only on request generations without cancellation.** Rejected because generation checks prevent stale publication but do not stop runtime startup, Gateway work, or browser connections that the user has already superseded.

**Persist metadata in local storage.** Rejected because document names and scope membership must not survive account changes or browser reloads outside the authenticated page lifetime.

## Consequences

Scope changes can still wait for a cold runtime on the first visit, but recent visits complete from memory and stale visits retain usable rows during revalidation. Cache capacity, freshness, maximum age, scope-qualified keys, and mutation invalidation bound both memory use and metadata lifetime. A stalled runtime metadata response ends at the configured Gateway deadline instead of holding the browser and runtime lease indefinitely.

## Verification

Client component tests cover visible rows during a pending switch, cancellation of a superseded request, retention after failure, fresh reuse without a request, stale-while-revalidate behavior, maximum-age eviction, changed account scope on reopen, legacy and cursor responses that precede scope discovery, and cursor paging while discovery is pending. Gateway coverage stalls both response establishment and JSON body reading through the metadata deadline, then verifies the 504 code plus balanced runtime lease calls. The client and Gateway TypeScript checks pass for the changed aggregates.

## Related

- [Document scope runtime readiness and safe provider projections](2026-08-26-document-scope-runtime-readiness.md) — owns Gateway readiness responses and idempotent metadata retries.
- [Document index pagination and recoverable trash](../architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.md) — owns cursor paging and the bounded page contract.
