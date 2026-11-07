# Agent Note: Indexed validation of managed backup paths

Status: implemented

English | [中文](2026-10-31-managed-snapshot-path-index.zh.md)

## Problem

The Admin deployment page periodically reads complete backup records. Repeated scans across every root and directory in each manifest can occupy the Gateway main thread long enough to delay unrelated Runtime registration and browser requests. The cost grows with both the number of roots and the number of members.

## Decision

`parseManagedSnapshot` indexes exact root paths, directory paths, file paths and absent roots for the duration of one parse. Root ownership follows normalized ancestor paths rather than scanning unrelated roots. The parser retains input order and all structural validation: duplicate members, overlapping roots, missing roots or parents, absent-root descendants, escaping paths and conflicting file/directory kinds remain errors.

The [deployment maintenance decision](../architecture/2026-09-25-gateway-deployment-maintenance.md) remains active and owns backup completeness, byte verification and restore exclusion.

## Alternatives considered

**Skip validation for listing.** Durable manifest data still needs validation before it is exposed or used for restoration.

**Cache parsed records globally.** That introduces retained state and invalidation obligations instead of removing repeated path comparisons within each parse.

**Increase startup deadlines.** That leaves unrelated requests blocked by synchronous work.

## Consequences

Temporary lookup memory grows with manifest membership and is released after parsing. Ancestor lookup depends on path depth rather than unrelated root count. The durable format, API response, stored bytes and restore checks remain unchanged. Generated compiled-module comparisons measure parser cost separately from database, browser and remote-network latency.
