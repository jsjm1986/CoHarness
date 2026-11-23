# Agent Note: Access invalidation retains Runtime write candidates

Status: implemented

English | [中文](2026-11-24-runtime-write-candidate-retention.zh.md)

## Problem

`PostgresInstanceRepository.invalidateRuntimeTokenCache()` cleared `executionWriteCandidates` together with the memoized token authorization and in-flight lookups. The repository subscribes that method to the scoped access monitor (`gateway/src/index.ts`), so every applied access revision — routine in multi-computer deployments where `LISTEN` delivers frequent revision events — dropped every learned personal and project write coordinate. The coordinates exist so the model credential endpoint can select the correct lookup scope before its single governance statement (`modelCredentialCandidate` for project coordinates, `personalExecutionCandidate` for personal); clearing them on every revision made the feature effectively dead and broke the isolation contract that `execution-runtime-isolation-postgres.spec.ts` asserts at three points.

## Decision

Invalidation again drops only `tokenCache` and `tokenFlights`; `executionWriteCandidates` persists across access revisions as a lookup-scope hint. This is safe because the candidates never authorize: the admission statement re-qualifies the exact credential, owner, node, and generation in PostgreSQL on every write, so a stale coordinate can only cost one mis-scoped query, never a wrong admission. The satellite-stack integration also left two test-only gaps repaired in the same fix window: the provider projection fixture still called the removed `runtimeProviders`/`runtimeProjectProviders` service methods instead of the exported `runtimePolicyFromRows` projection, and three transcript fixtures (`runtime-personal-policy`, `central-runtime-control`, `runtime-readiness-lifecycle`) leaked `[runtime-start-timing]` diagnostics into stdout snapshots until they set `HGW_PERFORMANCE_ENABLED: 'false'` like the established `runtime-start-observation` pattern.

## Alternatives considered

- **Keep the clear and update the spec** — clearing on every scoped access revision would discard the coordinates on precisely the event stream they exist to survive; admission would pay the scope-discovery query on nearly every model call while the hint table stayed empty.
- **Separate invalidation kinds** — distinguishing authorization changes from lifecycle stops would retain candidates on the hot path but adds a second invalidation contract for no safety gain, since candidates are hints and admission re-qualifies regardless.

## Consequences

Learned write coordinates survive access revisions and are still fenced by fresh SQL qualification at admission; token authorization remains fully invalidated. The provider projection fixture now exercises the production `runtimePolicyFromRows` function (exported with `RuntimePolicyRow`) rather than a service method that no longer exists, and the three transcript fixtures reserve stdout for their transcripts again.
