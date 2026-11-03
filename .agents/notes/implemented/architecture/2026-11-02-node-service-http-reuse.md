# Agent Note: Node service HTTP connection reuse

Status: implemented

English | [中文](2026-11-02-node-service-http-reuse.zh.md)

## Problem

High database round-trip time amplifies connection setup and serial permission reads. Opening a new service stream for each HTTP request repeats destination identity checks and a WebSocket handshake even when the preceding request completed successfully.

## Decision

The primary Gateway owns a bounded pool of idle HTTP service connections for each computer. A connection serves one HTTP request at a time. Browser WebSockets retain their separate, exclusively owned streams. Idle capacity and expiry use the existing node-service configuration owner and count toward its connection limits.

HTTP acquisition waits for owned borrowers or physical retirement when a burst reaches the service limit. The queue has explicit pending-request and elapsed-time limits; completed responses hand their connection to waiting borrowers, which renew authority before use. Cancellation withdraws only that waiter. Shutdown closes admission and joins waiters and active transports. A full budget consisting only of unrelated active streams retains its busy refusal. Queue wakeups do not replay an HTTP operation.

Transport reuse preserves authorization on both Gateways. Each borrower rechecks the exact node credential, connection UUID and lease epoch at the primary, while the destination retains its account, computer, project and Runtime checks. Withdrawal, channel replacement and shutdown close affected streams. Cancelling a request closes its borrowed connection without cancelling another request. Release and destruction retire the borrower once; a late callback from that borrower cannot close a successor's connection. Forwarded operations are never replayed after a failed reused connection.

Node credential lookup and row locking use materialized PostgreSQL queries. The credential lookup captures the original node, the lock reads its current row, and the outer query evaluates lease time after acquiring the lock. Detached state, credential replacement, organization status and connection generation retain their refusal semantics. Transactions keep their commit acknowledgement.

## Alternatives considered

**Cache node authorization with the connection.** This would let a revoked credential continue until transport expiry. Each borrower instead rechecks the credential and exact lease before forwarding.

**Share the control channel with HTTP bodies.** This would mix file and streaming backpressure with control probes and lease supervision. HTTP retains the existing independent service-stream protocol.

## Consequences

Transport reuse removes repeated destination identity handshakes without retaining permission results. Credential and lease checks remain per operation. Idle connections consume bounded service capacity and are reclaimed when they block new admission. The [retirement admission decision](../bug-fix/2026-11-01-node-service-retirement-admission.md) continues to own cleanup capacity and successor admission; pooling does not treat cancellation as confirmed cleanup.

## Verification

Socket tests cover reuse, bounded idle retention, expiry, cancellation, credential revocation, channel replacement, independent WebSocket streams, detach and shutdown. PostgreSQL tests exercise credential replacement, revocation, epoch and organization changes during lock waits, including a lease that expires without any row update. User acceptance measures the deployed Gateway path separately from model response time and verifies independent computer, Runtime, Workspace and browser-tab identities.
