---
kind: upgrade-guide
description: "Archive records use Runtime-local identity and current administrator qualification."
---

# Upgrade archive identity and administration

English | [中文](guide.zh.md)

## Change

Each archive record has an opaque `archiveId`; its `rootSessionId` remains the original Host Session identifier. Equal Host IDs in different Runtimes or computers identify independent records. PostgreSQL migration097 preserves existing Runtime assignments, search, commands and queued file cleanup; unassigned history remains separate when a new Runtime is created.

Archive clients use `/admin/api/archives/records` and `/records/:archiveId` with `/status` or `/export`. Batch actions use `/records/actions`, `archiveIds` in the request and `archiveId` in each result. Legacy root-addressed paths return410. Empty-draft preview and trash retain reviewed Runtime/Host pairs; follow the [Session identity migration](../postgres-session-runtime-namespace/guide.md).

Archive restore, trash, purge, settle and empty-draft cleanup now check and retain the active organization, authenticated administrator account and membership through transaction commit. An authenticated request queued before qualification withdrawal can no longer change archives afterward. Idempotent retries also require current qualification. Browser actor fields grant no authority.

Bulk endpoints preserve their per-item results: HTTP200 can contain refused items, whose errors indicate lost authority. Empty-draft cleanup returns403. Previously accepted commands remain pending for the owning runtime; trusted maintenance may still omit service actors on purge and settle.

Archive list, status, empty-draft preview, detail and export now retain current qualification during their database reads. Personal Runtime reads release the database client before waiting, retain the real administrator through startup and the read principal, then recheck qualification after completion or failure. Withdrawal returns403 without transcript or indexed fallback data. Operation leases use the returned Runtime generation. Omitted service actors remain reserved for trusted internal reads.

Blank-draft reservations refuse archived roots until restored, including a retry that proposes another Session id for the same draft. A reservation released during the root-lock wait returns HTTP400 and requires a new attempt. Empty-draft preview and confirmation exclude archived, trashed and purged roots and recent restorations; restoring an old blank Session gives it a fresh cleanup interval.

## Migration

1. Upgrade the complete Gateway and bundled Admin UI together; Gateway startup applies migration097. Update custom clients to the record routes and opaque IDs. Clear stale browser assets if a legacy path returns410. Do not substitute Host IDs for missing archive IDs.
2. Check every bulk result by `archiveId` before reporting success. After lost authority, refresh the account, organization status, role and membership before retrying.
3. Confirm that equal Host IDs in two Runtimes list as distinct records, actions and acknowledgements stay with their owning Runtime, and one purge preserves the other record and its files. Confirm that an active administrator can restore and trash an archive. Withdraw that administrator's qualification before a queued operation is accepted and confirm that both archive state and command ledger remain unchanged. See the [archive reference](../../../../gateway/README.md).
