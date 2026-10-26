# Agent Note: Gateway startup resilience

Status: implemented

English | [中文](2026-08-18-gateway-startup-resilience.zh.md)

## Problem

The macOS Gateway can be launched while its PostgreSQL container is still starting or briefly unavailable. Immediate startup failure makes launchd retry the whole process repeatedly, producing large logs and leaving recovery dependent on timing. A normal Gateway shutdown can also be forced while local runtime children remain alive, allowing an old runtime to retain a port after a replacement Gateway starts.

## Decision

Gateway startup retries only transient PostgreSQL connection and server-unavailable errors with configurable bounded exponential backoff. Credential, migration checksum, and inactive-organization errors remain fail-fast. The retry loop is abortable while a supervisor replaces the process, and diagnostics log only a database error code rather than a connection string.

The [default database client](../../../../gateway/src/postgres/client.ts) observes peer EOF on pg's initial stream and its negotiated TLS successor. A peer closing before local writable shutdown destroys that stream with `08006`, preserving a structured failure through both connect and query. Local shutdown, PostgreSQL refusal codes and TLS verification errors retain their existing handling. Ordinary queries are not automatically repeated; conversation reads use their existing dependency-failure category. Error classification does not parse messages, and custom `Client` implementations retain ownership of their streams. Stream observers are removed on close and the TLS observer leaves with its client.

`08006` is the SQLSTATE [connection-failure category](https://www.postgresql.org/docs/17/errcodes-appendix.html). pg can suppress `ECONNRESET` and `EPIPE` after an extended-query Sync; the connection-failure code preserves EOF through that path without inspecting driver-private state. Other socket errors keep their native handling.

The local launcher registers every child runtime in a process-wide exit cleanup set. A synchronous process-exit handler sends `SIGKILL` to still-running local children, so a forced Gateway shutdown cannot leave a runtime from the previous process holding an allocated port. Managed release deployments additionally pin the Gateway and child command to one immutable release and verify the new process before activation.

## Verification

Database retry tests cover transient recovery, bounded delays, wrapped errors, fail-fast non-transient errors, diagnostic redaction, and supervisor abort. Gateway configuration tests cover the retry defaults, overrides, and invalid windows. Existing release-control tests cover immutable release startup, activation rollback, and stale-runtime prune refusal.

Real pg connections to isolated loopback peers cover EOF before authentication and during a startup query, credential refusal followed by EOF, uncoded TLS refusal, verified TLS negotiation and EOF, certificate hostname refusal, intentional shutdown and supervisor cancellation. Fixtures allocate ephemeral ports and disposable certificate roots and await connection and listener cleanup.

## Alternatives considered

**Retry every startup error.** Rejected because bad credentials, migration drift, and inactive deployment records need an immediate operator-visible failure rather than an endless wait.

**Classify pg errors by their message.** Rejected because display text has no stable machine identity and an uncoded failure can also come from configuration. The transport observer establishes peer EOF before pg creates its generic closure error.

**Let launchd perform all database retrying.** Rejected because the Gateway would still have platform-specific startup behavior and could not distinguish transient PostgreSQL failures from invalid configuration.

**Rely only on graceful `stopAll()` during shutdown.** Rejected because forced exits, crashes during teardown, and supervisor deadlines can bypass the asynchronous cleanup path; the process-exit fallback is required for local child ownership.

## Consequences

When PostgreSQL is unavailable, the Gateway keeps its port unbound until the dependency returns, so `/healthz` is unavailable rather than falsely healthy. Operators must keep the PostgreSQL container supervised and run its readiness wait after Docker or host recovery. Local runtime children are terminated on process exit, while systemd-managed runtimes retain their existing supervisor-owned lifecycle.
