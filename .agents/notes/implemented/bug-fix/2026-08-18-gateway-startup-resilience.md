# Agent Note: Gateway startup resilience

Status: implemented

English | [中文](2026-08-18-gateway-startup-resilience.zh.md)

## Problem

The macOS Gateway can be launched while its PostgreSQL container is still starting or briefly unavailable. Immediate startup failure makes launchd retry the whole process repeatedly, producing large logs and leaving recovery dependent on timing. A normal Gateway shutdown can also be forced while local runtime children remain alive, allowing an old runtime to retain a port after a replacement Gateway starts.

## Decision

Gateway startup retries only transient PostgreSQL connection and server-unavailable errors with configurable bounded exponential backoff. Credential, migration checksum, and inactive-organization errors remain fail-fast. The retry loop is abortable while a supervisor replaces the process, and diagnostics log only a database error code rather than a connection string.

The local launcher registers every child runtime in a process-wide exit cleanup set. A synchronous process-exit handler sends `SIGKILL` to still-running local children, so a forced Gateway shutdown cannot leave a runtime from the previous process holding an allocated port. Managed release deployments additionally pin the Gateway and child command to one immutable release and verify the new process before activation.

## Verification

Database retry tests cover transient recovery, bounded delays, wrapped errors, fail-fast non-transient errors, diagnostic redaction, and supervisor abort. Gateway configuration tests cover the retry defaults, overrides, and invalid windows. Existing release-control tests cover immutable release startup, activation rollback, and stale-runtime prune refusal.

## Alternatives considered

**Retry every startup error.** Rejected because bad credentials, migration drift, and inactive deployment records need an immediate operator-visible failure rather than an endless wait.

**Let launchd perform all database retrying.** Rejected because the Gateway would still have platform-specific startup behavior and could not distinguish transient PostgreSQL failures from invalid configuration.

**Rely only on graceful `stopAll()` during shutdown.** Rejected because forced exits, crashes during teardown, and supervisor deadlines can bypass the asynchronous cleanup path; the process-exit fallback is required for local child ownership.

## Consequences

When PostgreSQL is unavailable, the Gateway keeps its port unbound until the dependency returns, so `/healthz` is unavailable rather than falsely healthy. Operators must keep the PostgreSQL container supervised and run its readiness wait after Docker or host recovery. Local runtime children are terminated on process exit, while systemd-managed runtimes retain their existing supervisor-owned lifecycle.
