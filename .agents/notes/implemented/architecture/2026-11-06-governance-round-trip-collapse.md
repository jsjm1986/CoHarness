# Agent Note: Collapse serial governance round trips for tunnel nodes

Status: implemented

English | [中文](2026-11-06-governance-round-trip-collapse.zh.md)

## Problem

Remote node gateways reach the central PostgreSQL through an SSH tunnel at ~200ms RTT. Two hot paths multiplied that RTT by statement count. Each `NodeResourceBudget.observe` round crossed the link as ~7 serial statements (transaction, `lock_node_resources`, clock read, observation update, conditional schedule, commit), so every ~10s sample burned ~1.4s of tunnel time per node. Every `authenticateRuntimeToken` call — issued once per runtime→gateway internal API call — ran a 6-table join plus two authority functions, roughly one execution per second per node; together with background pollers it saturated the node pool and pushed user requests on `ubuntu-101` to 8–16s.

## Decision

**Server-side observation round.** Migration `121_observe_node_resources.sql` adds `harness.observe_node_resources(tenant, computer, sample, elapsed_ms, initial_limits)`: insert-or-lock the resource row, sweep expired queued requests, reject stale captures, recompute credits from the sample and stored limits, conditionally schedule, all inside one call. `NodeResourceBudget.observe` now sends `performance.now() - capturedAt` as `elapsed_ms`; the function adds its own entry-to-post-lock wait, so a capture that expires while queued for the node lock is dropped exactly as the former post-lock measurement required. `set_config('lock_timeout', statement_timeout, true)` at the top of the function reproduces the client wrapper's `lockWait: 'statement'` bound within the call's implicit transaction.

**Runtime-token authentication cache.** `PostgresInstanceRepository` memoizes `authenticateRuntimeToken` per `sha256(token) + cleanup` key with a short TTL (`HGW_RUNTIME_TOKEN_CACHE_MS`, default off except in the gateway, which sets it), single-flight dedup, and a bounded LRU map. `harness_access_invalidation` notifications already reach every gateway through the existing listener and clear the cache, and token grant/revocation write paths clear it on commit. `runtime_node_execution_allowed` keys node authority on `node_connection_epoch`, so a node restart rotates the epoch and makes cached entries inert regardless of TTL.

## Alternatives considered

**Merge the whole request-resolution chain first.** The /account/api/context chain is data-dependent session→user→scope→runtime→admission reads; batching it pays off per request but leaves the continuous sampler and token streams multiplying RTTs forever. The observation round and token witness run unconditionally and at higher frequency than any single endpoint, so they were collapsed first.

**Signed center-issued authorization assertions.** The destination node would verify a signature instead of querying. That remains the planned next step; its trust registry now exists as `harness.compute_nodes.principal_public_key` (migration `122_node_principal_keys.sql`), which each gateway publishes at startup, plus `NodePrincipalDirectory`, a TTL-cached issuer-key reader that only honors nodes with a live managed agent lease or no agent row (directly provisioned gateways such as the center, whose revocation is row status). Assertion issuing and destination verification build on this in a follow-up.

**Cross-node write-path clearing.** The cache is per-process: a `markStopped`/`beginStart` on one gateway clears only that process. Remote gateways still learn the change through the 2s TTL, since runtime lifecycle writes do not bump `access_revision`; downstream generation checks inside resource operations fence any stale verdict within that window.

**Longer token TTL without invalidation.** Rejected: revocation must propagate at notification speed, not TTL speed, so the cache subscribes to the existing access-invalidation channel instead of lengthening staleness.

## Consequences

Measured on production with `log_statement='all'` windows: all three nodes emit `observe_node_resources` calls (~1.5–3.5ms server-side) and zero of the former statement chains; token witness executions on the Ubuntu pool dropped ~75%. Median `/account/api/context` on `windows-vps-47` fell to ~46ms node-side; `ubuntu-101` remains ~6s because its request-path serial reads and background pollers still multiply the 200ms RTT — merging those is the follow-up.

Semantics preserved and covered by `tests/node-resource-budget-postgres.spec.ts` (65/65): stale-while-queued captures are dropped, statement-bound lock waiting is unchanged, contention still surfaces `503 database-busy`, warnings bypass the cadence gate, and ordered witnesses keep rejecting older captures. Two test fixtures were rewritten for the single-call shape: the schema-shadowed `clock_timestamp` probe became a delayed-dispatch pool proxy, and the mocked-`performance.now` expiry test now holds the node lock past a real 50ms `staleMs`.
