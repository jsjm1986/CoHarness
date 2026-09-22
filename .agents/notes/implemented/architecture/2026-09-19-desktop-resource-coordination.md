# Agent Note: Gateway-coordinated interactive-desktop grants

Status: implemented

English | [中文](2026-09-19-desktop-resource-coordination.zh.md)

## Problem

Computer-use and browser-use drivers inject input into shared interactive desktops. A provider's sole-registration seam serializes drivers inside one runtime but says nothing about contention across runtimes: a personal runtime, a project runtime, a subagent, and a PTC call can all reach the same desktop, and clicks interleaved between independent tasks corrupt both runs. Coordination must live in the Gateway, which owns runtime authentication, durable records, and administrative authority.

## Decision

The Gateway owns a **desktop grant** per interactive desktop, keyed by an opaque resource pair `{node, desktop}`: the execution node hosting the desktop session and the node-reported desktop identifier. `gateway/src/desktop-coordinator.ts` implements the state machine over a durable repository (PostgreSQL `harness.desktop_*` tables, migration 028; an embedded SQLite repository serves tests).

- **Holder identity is server-derived.** A grant request arrives through the authenticated runtime loopback (`/internal/runtime/desktop/*`); the holder is projected from the verified `GatewayPrincipalClaims` — runtime kind/id/generation, user, scope, plus the caller's `runId` correlation and `requestId` dedup key. A client cannot assert a trusted holder.
- **Generation binding.** `acquire` verifies the claims' runtime generation against `InstanceManager.generationOf`; a stale-generation caller is rejected. Heartbeats authenticate the same way, so a restarted runtime cannot renew an old grant.
- **One grant per continuous task.** A driver acquires once for the whole task — the coordinator never rotates the grant between clicks — heartbeats while held, and releases at completion. A second holder queues FIFO per resource with `(holder, requestId)` dedup, cancellation, and a deployment-configured wait TTL and capacity.
- **Release requires confirmation.** A missed heartbeat, timeout, or admin revocation moves the grant `held → stopping`; the holder runtime confirms drained input via `confirm-stopped`, which releases the resource and promotes the queue head. Past the stopping deadline without confirmation the grant becomes `pending-confirm` and the desktop stays unavailable — no new grants, no promotion — until a confirmation or an admin `clear` lands. Stopping never retracts already-delivered input, and the product grant does not constrain the host operator's own work.
- **Fencing.** Each grant carries a per-resource monotonically increasing fencing token; the desktop host uses it to reject input from superseded holders.
- **Coordinator restart.** Grants and queue rows are durable. On boot the sweep reconciles rather than clears: `held` rows with expired heartbeats move to `stopping`, `stopping` rows past deadline move to `pending-confirm`; nothing is silently reissued.

Model-visible outcomes (granted, queued position, revoked, lost) return to the calling runtime, whose provider logs them into the session; the Gateway records acquisition, revocation, and force-clear decisions in the audit trail.

## Alternatives considered

**Per-runtime registry only.** The provider registration seam serializes drivers inside one runtime but cannot order a personal runtime against a project runtime or a subagent for the same desktop, and grants no admin revocation or restart-durable queue.

**Treat the runtime lease as the desktop lease.** Runtime leases track warm-instance bookkeeping for reaping; they carry no holder confirmation, fencing, or queue semantics, and conflating them would let a stopped runtime silently keep a desktop.

**Let the client claim its holder.** Self-asserted holders make dedup, revocation, and generation rejection unenforceable; holder identity therefore comes from the verified claims.

## Consequences

Acquisition and release pay one serialized transaction per resource (advisory lock on PostgreSQL, database mutex on SQLite) — a small cost against the click-interleaving corruption it prevents. A holder that disappears without confirming leaves the desktop `unavailable` rather than silently reissued, so operators gain an explicit recovery decision (`revoke`/`clear`, both audited) at the price of an occasional manual clear. Drivers must honor the fencing token and the stopping signal; provider code that ignores them can still inject into a superseded desktop.

## Verification

`gateway/tests/desktop-coordinator.spec.ts` covers two-runtime contention, stale-generation rejection, FIFO order, requestId dedup, cancellation, revocation with confirmation, heartbeat-loss → stopping → pending-confirm → unavailable, coordinator restart reconciliation, and confirm-stopped release; `gateway/tests/postgres.spec.ts` exercises the same paths against real PostgreSQL (advisory-lock serialization, promotion, restart durability, organization scoping). Deployment notes: drive only dedicated desktops and keep an emergency stop path. The periodic sweep runs at half the grant TTL; `HGW_DESKTOP_GRANT_TTL_MS`, `HGW_DESKTOP_STOPPING_TTL_MS`, `HGW_DESKTOP_QUEUE_TTL_MS`, and `HGW_DESKTOP_QUEUE_CAPACITY` size the coordination windows per deployment.
