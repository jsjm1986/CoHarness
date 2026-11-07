# Agent Note: Administrator page read ownership

Status: implemented

English | [中文](2026-10-23-admin-page-read-ownership.zh.md)

## Problem

Independent readers inside one administrator page can repeat the same authenticated database projection and wait behind identical browser requests. Organization Models derives its settings mirror, Provider directory and model directory from the same complete settings answer. Plugin, Terminal and SSH pages need a project list for both their primary controls and permission pickers. Usage receives the server's initial month as response data; treating it as another user selection repeats the initial overview, health and user reads.

## Decision

Reuse belongs to the mounted page and the operation that owns freshness. [The organization facade](../../../../gateway/admin-ui/src/model-settings-api.ts) shares only a pending organization-settings promise across its three readers. Each explicit `OrganizationModelsStore.load()` starts an independent read round before delegating to the existing Models store. Settlement releases the slot by promise identity, so an old completion cannot clear a newer read. Settings and credential writes invalidate reuse at admission and settlement, before successful-write notifications or conflict recovery can request fresh data. The [revision-fold decision](../bug-fix/2026-10-04-org-model-settings-revision-fold.md) continues to own write folding and the mirror's queued reread semantics.

[OrganizationModelsEditor](../../../../gateway/admin-ui/src/components/OrganizationModelsEditor.tsx) creates its facade and store in an effect, with a fresh abort controller for each effect setup. Cleanup aborts that owner's reads. Callback identity changes update the notification target without recreating the owner. An owner check after each awaited read rejects late answers and prevents an old Provider-list completion from starting credential reads after unmount. Individual readers have no cancellation authority over the shared request.

Plugin, Terminal and SSH pages pass their current project-list result, loading/error state and retry operation to the permission picker. The project read settles independently of unrelated user or SSH reads. A source error, reload or removed selection makes an older permission answer unusable; policy requests keep their own cancellation and generation checks. Callers without an owning project list retain the standalone picker read. No list survives page replacement or substitutes for server authorization.

Usage separates the requested month from the month returned by the server. The initial empty request leaves server time-zone selection authoritative. Displaying its returned month starts no request. User selection, clearing the selection and the existing post-write refresh remain explicit read operations, with generation and unmount checks protecting their results.

## Evidence and verification

The sanitized 15-page navigation capture contains six organization-settings GETs starting within 19 ms. The last takes 3,588 ms, including 3,078 ms recorded as browser `blocked`; these timings do not establish a 3.6-second SQL query. Each corresponding server read executes a constant sequence of revision, Provider, catalog and optional credential-state queries. It does not call the separate [Runtime Provider projection](2026-10-23-gateway-provider-projection-reuse.md).

The owning facade regression places all three readers behind a controlled pending answer: the unshared path issues three reads and the shared path one. A second regression keeps the previous round pending while starting an explicit refresh; removing the round fence produces one read where two are required. Owner-lifetime cases cover StrictMode cleanup/setup, callback replacement, remount, failure retry, writes, revision conflict and a late Provider list. These are request-count and behavior checks, not end-to-end latency, memory or machine-capacity measurements. Real authenticated browser validation remains separate from mocked REST fixtures.

Run the focused Models regressions from `gateway/admin-ui` with `npm exec -- vitest run src/model-settings-api.spec.ts src/pages/ModelsPage.spec.tsx`. Usage and permission-picker behavior remain covered by their owning page and component tests.

## Alternatives considered

- **A cross-page request cache.** It requires a separate invalidation policy for users, permissions, projects and settings. The measured duplicate work occurs within one page, so retaining settled answers adds stale-data risk without addressing another measured need.
- **One pending settings promise without a read round.** A refresh during an older request would reuse that older request and weaken the Models store's latest-generation behavior. A page-specific subclass marks the operation without expanding the shared Models store API.
- **Cancellation by any settings reader.** One dependent reader could cancel the mirror and its siblings. Cancellation belongs to the mounted owner; write and refresh fences retire reuse without aborting earlier consumers.
- **Using the browser's local month for initial Usage.** It changes the server-defined month at time-zone boundaries. The empty initial request is retained, while the returned display value is separated from user intent.

## Consequences

The three administrator paths remove repeated reads without retaining a second authorization or configuration cache. Explicit refreshes, writes, retries and page replacement remain freshness operations. Network, authentication, database execution and browser rendering still require measurement; request-count reductions do not establish their individual latency contributions.
