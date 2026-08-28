# Agent Note: Reclaim node-local instance ports

Status: implemented

English | [中文](2026-08-28-reclaimable-instance-port-allocation.zh.md)

## Problem

Gateway runtime ports were assigned as one greater than the highest port already present on a compute node. Deleted projects and logically deleted users could therefore leave gaps that were never reused. Repeated account or project churn eventually reached port 65535 even when lower ports were free.

## Decision

PostgreSQL user creation, project creation, and startup reconciliation select the first free port at or above `HGW_INSTANCE_PORT_BASE` while holding the existing node-scoped transaction advisory lock. The bounded query checks the node/port unique index and reserves as many candidates as the reconciliation batch needs. The SQLite compatibility provider uses the same first-free rule inside its transaction. A logically deleted user's operational instance row is removed after the runtime has been stopped, releasing its port; audit, usage, conversation, and home records remain available for history.

The allocator fails with an explicit node exhaustion error when the configured range has no free port. It never assigns below the configured base or above 65535, and the database unique constraint remains the final protection for writers outside the allocator.

## Alternatives considered

**Continue with `MAX(port) + 1`.** Rejected because monotonic allocation converts ordinary user and project churn into permanent port exhaustion despite free holes.

**Add a separate reusable-port table.** Rejected because it introduces another state machine and recovery path; the existing instance rows and node/port unique index already contain the authoritative occupancy set.

**Keep deleted users' instance rows as historical records.** Rejected because an instance assignment is operational state, not user history. Deleting that row releases the port without removing the durable records that explain the account's past activity.

## Consequences

Port allocation work scans at most the configured 1024–65535 range and uses the unique node/port index for occupancy checks. Allocation remains serialized per node, so concurrent user, project, and startup writes cannot choose the same candidate. A deleted user's `instances` row is no longer available to operational queries, and callers must treat the absence of a row as the stopped/decommissioned state for that account.

## Verification

SQLite service tests cover reuse after account deletion and PostgreSQL integration coverage exercises a removed project hole followed by a new project and user allocation. The PostgreSQL integration test remains opt-in through `HGW_TEST_DATABASE_URL`.
