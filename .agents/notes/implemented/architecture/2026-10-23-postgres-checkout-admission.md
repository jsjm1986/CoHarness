# Agent Note: Enforce admission at every PostgreSQL checkout

Status: implemented

English | [中文](2026-10-23-postgres-checkout-admission.zh.md)

## Problem

Gateway PostgreSQL callers use `pool.query()`, promise and callback `pool.connect()`, and transaction helpers. Enforcing `maxCheckoutQueue` only inside `connectFromPool()` leaves native query and direct checkout callers outside the same resource bound. Under overload, a bounded transaction path can coexist with an unbounded native pending queue, so its observed wait count does not describe the whole pool.

## Decision

[createPostgresPool()](../../../../gateway/src/postgres/database.ts) returns an internal subclass of the real `pg.Pool` with one admission owner at its `connect()` overloads. The native `pg.Pool.query()` implementation calls that method, so query, promise checkout, callback checkout and transaction helpers share one limit. Pending counts include connection establishment and waiting for a free client, and exclude clients whose checkout has completed. Pool size, statement execution, release, timeout and transaction behavior remain owned by pg.

An over-limit promise rejects with `DB_CHECKOUT_QUEUE_FULL`; a callback receives the same error asynchronously. Admission is released before notifying the caller after success or failure. A synchronous native failure rolls back its admission count; promise callers receive a rejection, while callback callers retain pg's synchronous-throw behavior. Once pool shutdown starts, pg's own use-after-end result takes precedence over an admission refusal.

Successful native checkouts attach the existing metadata-only checked-out client error guard exactly once per client. `connectFromPool()` delegates directly for Gateway-created pools, so transaction callers consume one admission slot. Its existing fallback adopts externally injected pools for helper callers; it does not modify an externally owned pool's native methods. [poolAdmissionSnapshot()](../../../../gateway/src/postgres/database.ts) returns current pending count, configured maximum and cumulative refusal count without SQL, credentials or account labels. It is separate from pg's native waiting count because connections still being established also consume admission.

Cancellation while waiting for a connection rejects the transaction immediately. A client delivered after cancellation is released exactly once and never executes the cancelled transaction.

The [Gateway observation decision](../testing/2026-10-23-gateway-performance-observation.md) owns process/request metrics and the offline HTTP baseline. Checkout admission changes overload behavior and bounds retained demand; it does not establish a higher sustained PostgreSQL throughput or a multiuser capacity result.

HTTP request owners map this admission error to 503. Usage intake keeps authentication and ingestion refusals retryable, so a valid usage record is retained by its sender rather than classified as a 400 input failure.

## Alternatives considered

**Wrap each service's `query()` call.** Rejected because a new caller or overload can bypass the wrapper, and every service would acquire admission ownership. pg's shared native checkout method already covers its query implementation.

**Add a second queue in front of pg.** Rejected because two independent wait queues obscure timeout and release ownership. The admission counter refuses excess demand without implementing another scheduler.

**Raise the PostgreSQL pool size.** Rejected as a substitute for admission because connection count does not bound pending callers and can increase database contention. Connection and queue limits require their own deployment evidence.

## Consequences

Every production checkout participates in the same configured unresolved-operation bound. Callers can encounter an explicit overload error rather than waiting in a growing queue; retry and user-facing status policy belong to their request owner. Active queries and checked-out transaction clients remain governed by pg's pool size and existing statement, lock and idle-transaction timeouts. Native pool state and Gateway admission state remain separately observable.

## Verification

The [keyless regression suite](../../../../gateway/tests/pool-admission.spec.ts) drives the actual pg pool using controlled Client implementations and no database socket. It covers native promise and callback query entry, direct checkout overloads, shared helper admission, asynchronous refusal, capacity recovery, connection failure, synchronous constructor/query failure, fake-clock checkout timeout, shutdown error precedence and checked-out error guards. The query-overflow regression fails against the helper-only implementation because an excess native query succeeds instead of receiving `DB_CHECKOUT_QUEUE_FULL`, and passes with the shared checkout owner. These tests establish queue semantics and failure cleanup, not PostgreSQL throughput.
