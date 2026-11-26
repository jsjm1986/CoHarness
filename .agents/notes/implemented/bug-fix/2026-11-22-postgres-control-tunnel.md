# Agent Note: Dedicated PostgreSQL control forward

Status: implemented

English | [中文](2026-11-22-postgres-control-tunnel.zh.md)

## Problem

An attached Gateway can use separate PostgreSQL pools over one SSH TCP connection. A delay in that connection can stall the readiness, lease and revocation queries even after PostgreSQL has completed the corresponding statements.

## Decision

An optional loopback port directs the reserved control and access-listener pools through an independent forward to the same PostgreSQL database. The configuration preserves the database, credentials and connection options. The business pool retains its original endpoint.

## Alternatives considered

**Extend the readiness deadline.** The same SSH stream would still carry business and control traffic, and the Gateway would take longer to report that it cannot read current authority.

## Consequences

Each configured forward needs independent supervision. Readiness still requires both current access observation and a matching write epoch. A failed control forward therefore makes the Gateway unready.

## Verification

Pool tests cover the unchanged default endpoint, dedicated port selection and invalid routing settings.
