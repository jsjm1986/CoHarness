# Agent Note: Node lease and control-channel authorization collapsed to single SQL functions

Status: implemented

English | [中文](2026-11-07-node-lease-control-functions.zh.md)

## Problem

`heartbeat()` and `authorizeChannel()` ran the same serial transaction on every call: `BEGIN`, deployment-topology gate (heartbeat only), `FOR UPDATE`/`FOR SHARE` lock of the node-agent row plus `FOR SHARE` of the organization row, optional lease renewal, `COMMIT` — four to five round trips each. On tunnel nodes every RTT costs ~270 ms, so each heartbeat held the row lock and a pooled connection for ~1.1 s while doing ~270 ms of work; channel authorization ran once per control message. Pool occupancy by maintenance transactions delayed browser requests behind node traffic.

## Decision

Migration 123 adds `harness.node_channel_lease` and `harness.node_heartbeat` (`VOLATILE SECURITY INVOKER`, `search_path=pg_catalog`). Each function performs the topology gate, credential lookup, row locking, taxonomy checks, and the lease renewal (heartbeat only) inside one statement from the client's perspective and returns a `jsonb` status payload. `PostgresNodeAccessService` issues exactly one pool query per operation and maps the payload back onto the existing `NodeAccessError` codes; request schemas are still validated before the call. The shared-lock model from [Shared node-channel authorization](../bug-fix/2026-10-31-node-channel-shared-authorization.md) is unchanged: `authorizeChannel` keeps `FOR SHARE` on the agent row, `heartbeat` keeps `FOR UPDATE`.

Preserved invariants and where they now live:

- **Error taxonomy and order**: not-found → `401`, `detached` → `409`, revoked/credential-mismatch → `401`, expired/connection/epoch mismatch → `409 lease-lost`, topology gate → `409 mode-disabled` (heartbeat checks it first, matching `primary(tx, false)` before `authenticate`).
- **Two-step identity then lock**: the credential-hash lookup resolves `node_id` on the pre-lock snapshot and the locking read joins by `node_id`, so a concurrent mutation that clears or replaces `credential_hash` (e.g. detach) keeps the row identity and the post-wait row version is what gets evaluated; the locked row's `credential_hash` is rechecked afterwards. A single `WHERE credential_hash=$x FOR SHARE` cannot express this — PostgreSQL re-evaluates the WHERE on the latest row version after the lock wait and the row would vanish.
- **Post-lock lease freshness**: `lease_expires_at <= clock_timestamp()` is evaluated in the `IF` after the locking `SELECT … INTO` returns. A `clock_timestamp()` expression placed in the locking SELECT's target list is computed before the lock wait ends and can report an expired lease as live; the former `target/locked` CTE relied on the same "outer clock after locks" ordering.
- **Atomic check-and-renew**: the heartbeat `UPDATE` keeps `lease_expires_at > clock_timestamp()` in its WHERE clause, so an expired lease still cannot be revived by a delayed heartbeat.
- Connection `connection_id`/`connection_epoch` comparisons use `IS DISTINCT FROM`, matching the former `!==` semantics including NULL.

## Alternatives considered

Merging `connect()` as well was rejected: it is low frequency and carries attachment, epoch-bump, topology-revision, and busy-mode branching that is disproportionate to its RTT savings. Collapsing `validateSession`'s two statements was rejected because the second read intentionally re-checks authority on a fresh snapshot after the session lock releases. Client-side caching of authorization results was rejected by the shared-authorization note's no-cache decision.

## Consequences

Each heartbeat and channel admission now pays one round trip instead of four to five; row-lock hold time on WAN links drops ~4×, and pooled connections cycle back to request work faster. The SQL functions duplicate the service's check order, so future taxonomy changes must update both the functions and any remaining transaction users (`connect`, `disconnect`, `release`) in the same release. Statement-capture verification requires resetting the database-level `log_statement='none'` and terminating pooled backends, because the database default is baked into pooled sessions at connect time.

## Verification

`gateway/tests/node-access-postgres.spec.ts` (26/26): one-round-trip query-count assertions for both operations; all six authority-mutation scenarios (revoked, expired, credential-replaced, detached, epoch-replaced, organization-disabled) verified through the lock-wait recheck path; lease expiry observed after an unchanged lock releases. Regression suites (runtime-catalog, computer-access, auth, deployment-topology) green; typecheck and build clean. Production: 46 `node_heartbeat` + 75 `node_channel_lease` executions in ~3 minutes, all bare single statements; three nodes stayed `active` with fresh heartbeats; a real prompt round trip through the public site returned a model reply on the Ubuntu node.
