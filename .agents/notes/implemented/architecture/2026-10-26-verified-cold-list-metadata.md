# Agent Note: Reuse verified cold list metadata

Status: implemented

English | [中文](2026-10-26-verified-cold-list-metadata.zh.md)

## Problem

Repeated Session lists can verify the same small cold logs when projection hints are absent or still blank. JSONL body reads discover the target across project directories. A fixed current-generation catalog with 123 Sessions across 27 directories and 77 eligible probes performs 4,281 generation-directory lookups per list, including repeated lists with identical output. This work also affects the personal catalog used by the workbench.

## Decision

ApiProxy retains only scalar summaries produced by successful bounded body verification. Each list still obtains fresh persistence snapshots. A retained row requires the same complete header and source-qualified revision. Projections, live attachment, readability and collaboration enrichment remain current-request work. The [bounded blank-verification decision](../bug-fix/2026-08-13-bounded-cold-blank-verification.md) continues to own eligibility, fallback direction and recency semantics.

Newly verified summaries remain in a request-local bounded staging cache until one additional snapshot list confirms their source identities. Changed or missing identities are discarded. Failed optional verification skips retention and reports a warning; cancellation propagates. Live summaries replace cold results again after this asynchronous verification. No log contents, authorization results, timers or shared in-flight operations are retained.

`coldSummaryCacheMaxEntries` defaults to 512 and `coldSummaryCacheMaxBytes` to 1 MiB of combined UTF-8 JSON identities and summaries. Either zero disables reuse and the additional verification. Both the ApiProxy cache and each request-local staging cache obey these limits. Encoded byte accounting does not claim to measure JavaScript heap overhead. ApiProxy disposal clears its cache and prevents late completions from repopulating it.

## Alternatives considered

**Cache the complete list response.** Rejected because attached state, projection checkpoints and current-principal access must remain fresh independently of durable log revisions.

**Trust blank hints or skip failed probes.** Rejected because an optimization miss must preserve the existing conservative visibility rules. Only successful body-derived metadata qualifies for reuse.

**Verify every candidate through a separate revision lookup.** Rejected because JSONL targeted lookup scans project directories. One shared snapshot verification avoids adding another project scan per eligible Session to the first list.

**Retain complete decoded logs or write summary sidecars.** Rejected because scalar list fields do not need event bodies or another durable index. The existing small full-log handoff cache and immutable Session generations retain their separate owners.

## Consequences

Unchanged repeated lists can avoid bounded body probes while discovery and source validation continue. The first list that populates the cache pays one extra metadata snapshot read. Entries absent from the cache, larger than its byte bound, lacking a revision, or affected by corpus revision changes use the ordinary verification path. This cache does not accelerate initial model requests, document conversion or network transport.

Unit coverage pins output identity, detached rows, changed headers and revisions, concurrent append, fresh projections and ACLs, failed verification, cancellation, byte and entry eviction, disabled reuse and disposal. The real compressed JSONL Web scenario repeats the sidebar snapshot after a page reload. The plain-Node diagnostic in `packages/host/apiproxy/tests/cold-list.perf.mjs` measures the built ApiProxy and JSONL provider with fixed metadata-hint counts, reports work and all samples, and keeps timing thresholds out of CI.
