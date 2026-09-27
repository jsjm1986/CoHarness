# Agent Note: File request text determines token pressure

Status: implemented

English | [中文](2026-09-22-token-meter-file-request-pricing.zh.md)

## Problem

A durable file reference contains its digest, name and byte count. The model receives a longer handle describing how to read the file in the current execution environment. Pricing only the reference understates this request and ignores path changes after a Session is restored elsewhere.

## Decision

The [token meter](../../../../packages/llm/token-meter/README.md) resolves every file occurrence through `ctx.llm.fileRequestText()` when measuring. It retains attachment identities beside the replay fold's heuristic nodes and independently replaces file and image structural prices, including nested tool results. Current nodes and successful-call anchors use the same request-time projection.

The [replay meter decision](../architecture/2026-07-15-replay-token-meter-service.md) remains authoritative for envelope matching, provider-usage anchors and immutable measurements. Fixed `heuristicTokens` and the bounded durable projections retain their reference-based accounting; provider-reported usage remains the billing authority. Missing LLM services keep the fixed heuristic, while missing readable paths use the LLM service's explanatory handle.

## Alternatives considered

**Reimplement the handle text in token-meter.** The LLM service owns the dispatched representation and execution-world path mapping. A second formatter could diverge even while both packages pass their own tests.

**Persist resolved paths or their prices in the projection.** The same durable reference can resolve differently after restoration or a provider change. Persisted prices would bind portable history to one execution environment and make replay depend on stale access facts.

## Consequences

File-bearing requests influence compaction pressure through the representation actually sent to the model. Request estimates can change without a new Session event when file access changes; earlier immutable measurements stay unchanged. Durable composition projections remain fixed-heuristic estimates and can differ from the live request measurement.

## Verification

A Loader composition uses real attachment storage, filesystem mapping and LLM projection, then compares the meter with the file-handle message observed by an external-model adapter double. Restoring the same log and bytes under another storage root changes the request price without changing the durable projection. Owner tests cover unavailable paths, nested image/file mixtures and matching usage-anchor repricing.
