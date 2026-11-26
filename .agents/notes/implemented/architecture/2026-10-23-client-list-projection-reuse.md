# Agent Note: Reuse client list projections by source identity

Status: implemented

English | [中文](2026-10-23-client-list-projection-reuse.zh.md)

## Problem

One Session update republishes list snapshots used by row selectors. Reconstructing every summary changes unrelated selector results even when their manager entries retain identity. The account pool adds another projection for runtime-qualified ids and project labels. Its reuse must distinguish changed Session data from a changed owning runtime descriptor.

The Documents manager creates its HTTP client from a same-bundle factory with a required `browseScope` method. Treating that method as optional and checking the arity of `listScope` adds a second compatibility mechanism for a client implementation production never substitutes.

## Decision

The runtime memoizes a `SessionSummary` by its immutable manager entry. The account pool memoizes the qualified summary by that source summary and the runtime descriptor identity. Weak keys follow the source rows' lifetime without a second strong retention registry. A project-name or runtime-target change replaces the pooled projection. Manager entry reuse compares visibility and project id alongside its other published fields.

The Documents manager calls the typed `browseScope` method directly. The HTTP client's existing missing-route fallback preserves compatibility with older Hosts, including directory and paging arguments. Component fixtures provide the same required method as the production factory.

The [client architecture](2026-07-19-gui-web-client-architecture.md), [multi-session workbench](2026-09-08-cordis-multi-session-workbench.md), and [document scope switching](../bug-fix/2026-08-27-stable-document-scope-switching.md) decisions retain their separate loading, ownership, and metadata-cache rules; none is superseded by row projection reuse.

## Alternatives considered

**Compare full list data in React.** This puts repeated comparison work in every consumer and leaves the object layer publishing changed references for unchanged rows. Producer-owned reuse keeps `Object.is` selectors sufficient.

**Cache only by Session id.** An id does not identify a summary revision or a runtime descriptor. Such a cache needs separate invalidation and eviction to prevent stale metadata and retained deleted rows.

**Keep alternate local document-client implementations.** The manager has no production client-injection protocol; it creates the typed factory itself. Real compatibility belongs to the HTTP response and route handling already implemented there.

## Consequences

Unrelated updates preserve row identity without changing list order, Session references, or connection ownership. List construction still traverses the catalog. The immutable manager entry and runtime descriptor identities determine when the pool can reuse a row.

The workbench does not republish the account and current-scope directories when its cleanup releases no Runtime. Opening a conversation already publishes its selection. When cleanup releases a Runtime, the pool publishes its removal before stopping its connection and resources. The [client interaction decision](2026-10-23-client-interaction-work.md) separately owns selective settlement replay and navigation invalidation.

## Verification

Runtime and pool regressions cover unrelated row identity, changed status, visibility and project metadata, and renamed runtime labels. The [pool regression](../../../../packages/client/runtime/tests/session-pool.client.spec.ts) asserts that clearing an empty workbench keeps both directory snapshot references. The document component suite exercises scope navigation through the required client method; the HTTP-client suite retains the missing-route fallback case.

The package-local [source diagnostic](../../../../packages/client/runtime/tests/list-projection.perf.client.ts) creates 1,000 synthetic rows and applies 100 single-row status updates in each of three fresh object graphs. Published runtime and pooled summary replacements are 100 each, compared with 100,000 each without reuse. On the local Node 25.8.1 source run, the three elapsed samples are 276.13, 248.64, and 193.66 ms, compared with 409.36, 272.62, and 297.99 ms without reuse. These timings include source execution and reference counting; they are diagnostic observations, not browser measurements or CI budgets.

A local Chromium fixture compared built browser assets with and without the extra directory publication. With a fixed 50 ms response delay and 50 repetitions per build, the P95 for opening prepared history was 178.4 ms with the extra publication and 155.2 ms without it; prepared creation was 194.7 ms and 169.5 ms respectively. This comparison measures the browser path against fixture responses, not latency across deployed nodes.
