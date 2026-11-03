# Agent Note: Shared node-channel authorization

Status: implemented

English | [中文](2026-10-31-node-channel-shared-authorization.zh.md)

## Problem

Every control-socket check and forwarded service connection authenticates the same node credential. Exclusive row locks serialize these read-only transactions. A Gateway reaching PostgreSQL over a slow network holds the lock across several round trips, delaying other browser requests and the node heartbeat.

## Decision

`authorizeChannel` holds `FOR SHARE` on the node-agent and organization rows until its transaction finishes. Concurrent authorization reads can proceed together. Enrollment, connect, heartbeat, disconnect and administrator mutations retain exclusive node-agent locks. A read waiting behind a mutation rechecks its resulting credential and current expiry; it cannot revive an expired lease or a revoked credential. No authorization result is cached.

## Alternatives considered

`FOR KEY SHARE` permits updates to non-key credential and lease fields while a reader owns the row. It does not preserve the required ordering with revocation. Cached credentials also delay observing revocation. Both are unsuitable for admission.

## Consequences

Each connection still pays its own database and network round trips. Concurrent reads no longer retain an exclusive node lock across that work; mutations wait for accepted readers before committing. Transport deadlines and connection capacity continue to bound admission.

## Verification

The real PostgreSQL node-access fixture retains a shared reader and completes two channel checks before releasing it. Separate controlled writer waits verify that committed revocation and expiry refuse subsequent admission. The assembled two-Gateway transcript exercises the same transport authorization without changing Runtime identities or execution permissions.
