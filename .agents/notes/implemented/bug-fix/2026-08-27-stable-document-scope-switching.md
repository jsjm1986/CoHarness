# Agent Note: Stable document scope switching

Status: implemented

English | [中文](2026-08-27-stable-document-scope-switching.zh.md)

## Problem

A cold or busy project runtime can make scope listing wait through Gateway authorization, runtime readiness, and bounded retries. The manager replaced the visible list with a blocking skeleton and allowed superseded requests to continue, so a slow or failed switch appeared as a blank panel and stale responses competed for UI state.

## Decision

The Documents manager keeps the last committed listing visible while a scope, directory, page, or refresh read is in flight. A lightweight refreshing state identifies the pending target; blocking skeletons are used only before the first listing is available. Every listing operation owns an `AbortController` and increments request generations; starting a newer operation aborts the previous one and late responses cannot publish. Reads of remote scopes reuse a bounded in-memory page or listing cache keyed by scope, directory, filters, and sort, then revalidate while the cached rows remain visible. Failed revalidation keeps cached or previous rows and shows the error. Legacy metadata-only clients use the same bounded listing cache when they cannot accept an abort signal.

## Alternatives considered

**Always replace rows with a skeleton during a read.** Rejected because a runtime readiness delay is expected for a cold project and hiding a valid committed result turns a wait or recoverable error into a blank panel.

**Prewarm every project runtime when the manager opens.** Rejected because organizations can expose many projects and eager startup would consume processes and resources for scopes the user may never open.

**Rely only on request generations without cancellation.** Rejected because generation checks prevent stale publication but do not stop runtime startup, Gateway work, or browser connections that the user has already superseded.

## Consequences

Scope changes can still take as long as the selected runtime needs to become ready, but the manager remains usable and reports the pending target instead of blanking the list. Repeated visits to a scope can show a bounded cached page immediately while the Gateway result is refreshed. Cache entries are metadata-only, scope-qualified, and evicted when their bounded capacity is reached; mutations clear the listing caches before reconciliation.

When the initial runtime page arrives before account scope discovery, its short-lived cursor chain stays attached to the active request until the scope is confirmed. Paging can therefore continue without assigning an unconfirmed runtime result to a scope cache.

## Verification

Client component tests cover visible rows during a pending switch, cancellation of a superseded request, retention of rows after a failed switch, cached scope reuse, and cursor paging while scope discovery is pending. Existing cursor, mobile, style, and HTTP-client tests continue to pass. The package TypeScript check passes for the changed client aggregate.

## Related

- [Document scope runtime readiness and safe provider projections](2026-08-26-document-scope-runtime-readiness.md) — owns Gateway readiness responses and idempotent metadata retries.
- [Document index pagination and recoverable trash](../architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.md) — owns cursor paging and the bounded page contract.
