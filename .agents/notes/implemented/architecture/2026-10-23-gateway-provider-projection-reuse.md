# Agent Note: Query-local Gateway Provider projection reuse

Status: implemented

English | [中文](2026-10-23-gateway-provider-projection-reuse.zh.md)

## Problem

The PostgreSQL runtime-policy queries join each enabled model to its Provider. A Provider's complete JSON profile therefore appears in every model row. Cloning, removing legacy literal keys and searching the configured model list for each row repeats work quadratically as a Provider's model count grows. This projection participates in governance preparation before managed Runtime use, including warm reuse; optimizing only process startup leaves this work in the request path.

## Decision

Reuse belongs to one query result in the [PostgreSQL governance service](../../../../gateway/src/postgres/model-governance-service.ts). Organization and project projections each normalize one profile and build one configured-model index per Provider. The index keeps the first occurrence of a duplicate model id, preserving the existing ordered lookup. Provider/model ordering, project route prefixes, embedded endpoint normalization and legacy-key removal remain unchanged.

A later policy read constructs a fresh projection from its own rows. No process-wide or cross-request cache is introduced: model access, configuration revisions and credential updates must retain their existing observation points. The [Provider ownership decision](../feature/2026-08-17-organization-model-provider-ownership.md), [project settings decision](../feature/2026-08-28-project-scoped-settings-management.md) and [live policy reload decision](../feature/2026-08-14-gateway-model-governance-live-policy-reload.md) retain their independent authority and publication rules.

## Alternatives considered

**Cache complete Provider projections across requests.** Rejected because Provider identity alone does not identify its current configuration or authorization revision. That optimization requires explicit revision fencing, invalidation and retention ownership; eliminating duplicate rows within one already-read result requires none of those mechanisms.

**Normalize once but search the configured array for each model.** Rejected because it retains quadratic lookup work. An invocation-local index removes repeated searches while an explicit first-entry rule preserves duplicate-id behavior.

## Consequences

Projection cloning and model indexing are linear in the configured profile plus returned model count. The temporary index adds one entry per distinct configured model and becomes unreachable after projection construction. The returned profile still retains its complete configured model array. PostgreSQL JOIN transport and JSON decoding still repeat the profile per model row; this decision does not reduce that database or wire work.

## Verification

The [focused tests](../../../../gateway/tests/runtime-provider-projection.spec.ts) cover both scopes, one clone per Provider, first-entry duplicate lookup, metadata and key removal, malformed stored profiles, Provider isolation and updated profiles on subsequent reads. Their work-count assertion fails on the unoptimized implementation: two Providers with 16 and 8 models clone 24 profiles rather than two.

After building the current Gateway source, run `npm exec -- tsx gateway/tests/runtime-provider-projection.perf.ts` from the repository root. The [diagnostic](../../../../gateway/tests/runtime-provider-projection.perf.ts) invokes the actual built projection with synthetic JOIN rows and no database, credentials, listener or model call. Source orchestration drives the built module; it records work counts rather than elapsed time.

| Models per Provider | Profile clones: baseline → reuse | Cloned model entries: baseline → reuse |
|---|---|---|
| 16 | 16 → 1 | 256 → 16 |
| 64 | 64 → 1 | 4,096 → 64 |
| 256 | 256 → 1 | 65,536 → 256 |

Both organization and project projections produce these counts on Node 25.8.1, macOS arm64. They establish removed local work, not complete space-switch latency, machine capacity or support for 300 online users and 100 mixed tasks. Database decoding, authentication, network, Runtime readiness and browser rendering are excluded. The [Gateway observation decision](../testing/2026-10-23-gateway-performance-observation.md) continues to own deployment measurement limitations.
