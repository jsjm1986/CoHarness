# Agent Note: Socket-owned renewal of short Gateway principals

Status: implemented

English | [中文](2026-10-23-event-stream-principal-renewal.zh.md)

## Problem

A signed request principal has a finite lifetime, while an event WebSocket commonly outlives one HTTP operation. Giving a retained collaboration authority only the initial expiry closes an otherwise healthy browser generation after about 30 seconds. Reconnection repeats Host and workspace bootstrap and cancels active reads. Extending the assertion TTL would also extend stale authority; refreshing a login through its ordinary validation path would silently turn background sockets into login activity.

## Decision

The Gateway owns a registration for each admitted mux/host event socket. Its original nonce identifies the registration; its original login, user identity and permissions, selected scope, Runtime target and generation remain server-owned. Runtime requests contain only a bounded list of existing registration ids and travel through the existing private runtime bearer HTTP channel. They cannot choose a user, scope, deadline or new registration. HTTP operations and purpose-bound assertions are not renewable.

Renewal synchronizes the [durable access monitor](2026-09-22-cross-gateway-access-invalidation.md), reads current login eligibility without locks or writes, checks current project authority, rechecks Runtime bearer generation and synchronizes again before issuing. Two sockets with the same login and target share qualification within that batch; no result survives the request. Identity, role or scope-permission changes deny renewal rather than silently changing a retained authority. The new deadline is bounded by the existing login deadlines, the configured principal TTL and a fixed 30-second maximum. The ordinary login validator retains its separate activity and sliding-expiry behavior.

A Runtime-local pool owns one in-flight bounded batch and exposes a verified principal handle to the retained collaboration authority. Every replacement must have the same identity/permissions/scope/generation, a valid signature, a later expiry and a fresh nonce. The preceding signed expiry remains armed until verification completes. Gateway and Runtime both retain expiry timers; socket closure, monitor loss, disposal, denial, expiration and generation replacement cannot be reversed by a late response. A missing response grants no additional Runtime lifetime. Cancellation retires authority immediately, but the pool joins the actual transport and response-body reader before accepting another batch or finishing disposal. The [Connection authentication decision](2026-10-01-browser-auth-web-transport.md) continues to own initial browser admission; renewal grants neither execution authority nor Inspector access.

## Alternatives considered

**Longer signatures or removing expiry.** Rejected because an independently retained assertion would remain usable longer after a missed revocation. Each replacement remains short and requires current qualification.

**Refresh through ordinary login validation.** Rejected because validation updates activity and sliding expiry. A background event connection must not keep its original login alive.

**Browser refresh messages or a general refresh token.** Rejected because existing Runtime-to-Gateway transport already authenticates the current Runtime generation. A server-owned live-socket registry avoids adding browser capabilities or a separately redeemable token.

**One private HTTP request per stream.** Rejected because each browser already has two event streams and can retain more targets. Bounded batching shares same-session/target reads and limits in-flight transport without retaining an ACL cache.

## Consequences

The registry stores one small entry and deadline per live event socket. Each Runtime has one batch request, capped by its configured batch size and the earliest participating expiry; deployment pacing is configurable in [Gateway settings](../../../../gateway/README.md). Severe transport or database delay may still expire a connection, intentionally requiring fresh admission. Configuration reaches already-running Runtimes only through a new launch credential; mixed releases fail closed with fixed expiry rather than bypassing verification. Reconnects caused by transport loss, process replacement or real access changes remain supported and expected.

## Verification

The [real proxy tests](../../../../gateway/tests/proxy.spec.ts) cap the first event grant at a five-second remaining login deadline, close it without renewal and retain ordinary HTTP signing behavior.

[Gateway registry tests](../../../../gateway/tests/stream-principal-leases.spec.ts) cover coalescing, original-login deadlines, unknown ids, target/generation isolation, role/login changes, bounded invalid requests and close/expiry/monitor races. [Private route tests](../../../../gateway/tests/runtime-api.spec.ts) require runtime bearer authentication and recheck generation after qualification. [Runtime pool tests](../../../../packages/context/gateway-runtime/tests/stream-principal-leases.spec.ts) use signed synthetic assertions and controlled time for denial, forged signatures, changed authority, replay, non-advancing or expired grants, lost replies, concurrent batches and late completion after close/disposal.

The [real Loader test](../../../../packages/context/gateway-runtime/tests/stream-principal-admission.host.spec.ts) boots Connection, Web server, frontend-static and GatewayRuntime on private ephemeral ports, opens both actual WebSocket carriers, and renews through the private HTTP transport beyond the initial signed deadline while the original HTTP assertion receives 401. Its disabled case sends no renewal. Existing [API Proxy expiry tests](../../../../packages/host/apiproxy/tests/api-proxy-collaboration.spec.ts) remain, alongside current-deadline tests for both streams. These are deterministic protocol and lifecycle checks; they do not establish deployment capacity or a measured end-to-end speedup.

The same runnable Loader flow is replayed by the [keyless application snapshot](../../../../scripts/event-principal-renewal.snapshot.ts); its transcript records enabled and disabled carriers without tokens, assertion bytes or clock values.

The [native HTTP teardown regression](../../../../packages/context/gateway-runtime/tests/stream-principal-io.host.spec.ts) observes the production renewal closure reading an incomplete chunked JSON response. Pool disposal returns only after the real renewal and reader cancellation settle; restoring the race-only join fails that assertion. On Node 25 the reader cancellation already settles before the renewal promise, so the shared body-reader helper is unchanged.
