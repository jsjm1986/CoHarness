# Agent Note: Burst memoization of exact-id runtime catalog resolution

Status: implemented

English | [中文](2026-11-07-catalog-exact-id-resolve-memo.zh.md)

## Problem

Remote Gateways reach central PostgreSQL over SSH tunnels at ~250 ms per round trip, and a single forwarded request resolves the same runtime environment more than once: the node-service proxy verifies `resolveForAccount` while checking placement, and the `/api` dispatcher resolves the identical id again before dispatching. At ~270 ms per catalog query, the duplicate resolution is pure latency on every remote call, and a browser burst (`workbench-rows`, `workspace.list`, `session.list` against the same runtime) repeats it per request.

## Decision

[resolveForAccount](../../../../gateway/src/postgres/runtime-catalog.ts) memoizes a *successful* resolution for 800 ms, keyed by `actor.id` + environment id, sharing one in-flight promise across concurrent callers and bounding the map at 512 entries. Errors are never retained: a rejected load deletes its own entry only, so denial and grant transitions observe the next request immediately.

Only exact-id resolution is memoized. `resolveForOwner`, `resolveForLanding`, all `pageFor*` listings, and `resolveForAdministrator` still query on every call: selector ambiguity and landing order must observe newly added environments on the very next request, which the directory specification test `enters a stable authorized personal default...` proves by requiring 409 immediately after a second personal environment appears.

## Why exact-id resolution is safe to memoize

- The resolved identity fields (owner, node, runtime id) are immutable while the instance is active — the schema check constraints reject owner/node reassignment (`rejects forged identities, changed owners and reassignment of an active process`).
- Retirement can only mask for ≤800 ms, and downstream attach paths fence on live instance rows and generation (`beginStart` returns `unavailable`), so a stale positive can never execute against a deleted runtime.
- Authorization loss binds within the same bounded window, matching the existing TTL precedents (`authenticateRuntimeToken` token-witness cache, 300 ms maintenance-gate cache).

## Alternatives considered

**Memoize all selectors.** Rejected: `resolveForOwner` ambiguity detection must see a concurrently inserted environment; caching masks it for the TTL.

**Per-request memoization only.** Would require plumbing a request scope through the proxy and dispatcher; the burst window captures the same dedup plus cross-request fan-out with one seam.

**Merge the two `validateSession` statements.** Still rejected — the renewal `FOR UPDATE` plus post-lock fresh snapshot is the deliberate revocation-visibility contract asserted by `auth-postgres.spec.ts`.

## Consequences

Each remote forwarded request saves one catalog round trip (~270 ms on tunnel nodes); browser bursts save one per repeated resolution. Worst-case staleness is 800 ms on placement metadata that downstream fencing already re-verifies. The remaining serial chain on the remote request path (`owner()`, instance status, resource reservation, `record_runtime_activity`) is the documented follow-up — merging it requires generation-fence analysis and is not covered here.
