---
kind: upgrade-guide
description: "Maintenance administration retains current authority and commits transitions with their operation rows."
---

# Upgrade maintenance administration

English | [中文](guide.zh.md)

## Change

Maintenance administration reads, entry, exit, node-status changes and restore registration retain the authenticated current active organization administrator through transaction commit. Browser actor fields grant no authority. A request waiting before qualification withdrawal returns403. The trusted independent applier passes explicit `null` and retains its deployment ownership.

Entry, exit and node-status changes commit with their operation row. Concurrent entrants create one maintenance epoch and one entry operation. An operation-row failure rolls back its transition and returns503. Restore registration checks and retains an organization-owned verified complete backup until the pending request commits. A backup whose verification is withdrawn before acceptance returns409. Accepted requests remain work for the independent applier under the existing maintenance and recovery checks.

## Migration

1. Upgrade the complete Gateway. Existing configuration, PostgreSQL schema, operation rows and HTTP response fields need no migration.
2. After403, refresh the account, role, membership and organization status. After409, verify the selected backup and choose a complete verified record before retrying.
3. Exercise concurrent maintenance entry and an ordinary administrator enter/exit cycle. Confirm one entry operation and the accepted epoch. A rejected database transaction must preserve the previous cluster and node state.
4. Preserve the independent applier and deployment recovery access. See the [maintenance reference](../../../../gateway/README.md).
