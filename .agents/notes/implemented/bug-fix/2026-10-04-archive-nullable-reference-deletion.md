# Agent Note: Null only nullable archive references on deletion

Status: implemented

English | [中文](2026-10-04-archive-nullable-reference-deletion.zh.md)

## Problem

Released, immutable migration `015` defines five composite archive foreign keys whose unspecified `SET NULL` column list also clears non-nullable `organization_id`. With those definitions, PostgreSQL raises `23502` in the real `PostgresProjectService.remove` path for a project with an archive, and in physical fixture-user deletion.

## Decision

Monotonic migration `050` re-adds the same five foreign keys with unchanged columns and constraint names. It keeps each full composite organization check and explicitly nulls only `project_id` or the affected nullable user-reference column. Organization, root, and runtime identity stay intact.

This does not promise transcript survival after project deletion. Production user removal remains logical rather than physical.

Creator filters resolve retained control-database account identities without requiring the creator to remain login-eligible. Shared and node-volume archives apply the same historical identity rule. The authenticated administrator still requires current qualification; historical creator lookup grants no access to that creator.

Organization and `publicId` rules remain owned by the independent [PostgreSQL baseline and runtime cutover architecture](../architecture/2026-08-14-postgresql-jsonb-gateway-baseline.md).

## Alternatives considered

**Edit released migration `015`.** Deployed migration checksums would no longer match.

**Drop organization from the foreign keys.** This weakens cross-organization reference checks.

**Detach archive metadata in an admin wrapper.** Alternate deletion callers still reach the faulty foreign keys.

## Consequences

Archive references can be cleared without violating organization identity or weakening composite foreign-key checks. Existing installations receive the correction through a monotonic migration without changing released migration checksums.

## Verification

[Admin business PostgreSQL specifications](../../../../gateway/tests/admin-business-postgres.spec.ts) and [PostgreSQL specifications](../../../../gateway/tests/postgres.spec.ts) verify real-service project deletion, physical fixture-user deletion, organization retention, actor-reference nulling, foreign-organization rejection with `23503`, and upgrade/idempotence from the old migration.
