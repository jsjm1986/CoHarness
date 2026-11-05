---
kind: upgrade-guide
description: "Maintenance administration retains current authority and commits transitions with their operation rows."
---

# Upgrade maintenance administration

English | [中文](guide.zh.md)

## Change

Maintenance administration reads, entry, exit, node-status changes and restore registration retain the authenticated current active organization administrator through transaction commit. Browser actor fields grant no authority. A request waiting before qualification withdrawal returns403. The trusted independent applier passes explicit `null` and retains its deployment ownership.

Entry, exit and node-status changes commit with their operation row. Concurrent entrants create one maintenance epoch and one entry operation. An operation-row failure rolls back its transition and returns503. Restore registration checks and retains an organization-owned verified complete backup until the pending request commits. A backup whose verification is withdrawn before acceptance returns409. Accepted requests remain work for the independent applier under the existing maintenance and recovery checks.

Backup creation retains the initiating administrator through command admission and registry insertion. Verification retains that actor through status updates; withdrawal cannot mark a valid backup failed. Configuration preview checks current authority again before publishing its POST read result. A refused preview does not undo a verification update already admitted before withdrawal. Captured files from a later refused registration remain available for operator cleanup. Administrator transactions finish before native commands; the independent deployment data lease remains held.

Backup verification and configuration preview accept the hyphenated UUID returned by the registry. Malformed or non-string selections return400 before backup work; a well-formed missing record returns404. Uppercase UUIDs remain accepted.

## Migration

1. Upgrade the complete Gateway. Existing configuration, PostgreSQL schema, operation rows and HTTP response fields need no migration.
2. After403, refresh the account, role, membership and organization status. After409, verify the selected backup and choose a complete verified record before retrying.
3. Exercise concurrent maintenance entry and an ordinary administrator enter/exit cycle. Confirm one entry operation and the accepted epoch. A rejected database transaction must preserve the previous cluster and node state.
4. Preserve the independent applier and deployment recovery access. See the [maintenance reference](../../../../gateway/README.md).

Custom service adapters forward the authenticated actor to `verify(id, signal, administratorUserId)` and `previewNodeConfiguration(id, administratorUserId)`. Registry reads and verification updates preserve a supplied actor on the same transaction connection. Omission is reserved for trusted internal work; backup creation and operation logging use explicit `null` for the independent applier.
