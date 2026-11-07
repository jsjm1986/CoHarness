# Agent Note: Document identity stores self-heal inode-proven remounts

Status: implemented

English | [中文](2026-11-04-document-identity-remount-self-heal.zh.md)

## Problem

Legacy (schema 2/3) and unmigrated schema-4 document identity stores refused to open after an OS remount changed the volume device number, even though every recorded inode still matched. `verifyLegacyStorage`, `bindStorageInside`, and the private `domain.json` marker each required exact device equality for volume-less recorded witnesses; only the offline `recoverDocumentIdentityMount` backup path could normalize devices, and it demands an independent pre-remount snapshot that rarely exists. A reboot therefore bricked every legacy document store before its first writable open could migrate it to schema 4 and acquire persistent filesystem UUIDs — a bootstrap deadlock.

## Decision

The open and mutation paths attempt verified recovery when the strict check refuses: `verifyLegacyStorage(binding, recovered)` and `bindDomain`'s marker comparison admit a changed device number only when every recorded inode agrees and current descriptors carry persistent volume UUIDs. `recoverDomainMount` rewrites version-1 markers to version 2 with the acquired UUID; `recoverMount` then normalizes recorded devices and persists the UUIDs, so the store becomes immune to future device drift on its next open.

- `identity.ts` — `verifyLegacyStorage(binding, recovered)` treats `recorded.inode === current.inode && current.volume !== undefined` as proof for volume-less legacy rows.
- `identity-storage.ts` — `recordedObject` accepts `recovered` for device tolerance; `bindDomain` forwards it and rewrites recovered markers to version 2; `recoverDomainMount(rootId)` requires readable volume UUIDs and never initializes.
- `identity-fs.ts` — legacy open retries `verifyLegacyStorage` with `recovered` after `DocumentIdentityConflict`, and `recoverDomainMount` after a marker refusal.
- `mutation.ts` — first mutation tries `bindDomain` then `bindStorage`, recovering each witness independently on refusal; re-entry recovers only the marker.

## Alternatives considered

- **Routing every remount through the offline verified-restore path** lost to the observed deadlock: `recoverDocumentIdentityMount` demands an independent pre-remount snapshot that almost never exists in the field, so requiring it leaves stores bricked.
- **Admitting inode agreement without readable volume UUIDs** lost because a store that cannot persist UUIDs gains nothing durable from normalization; hosts without UUIDs keep the strict refusal.
- **Accepting device drift without inode proof** lost because volume-level clones are indistinguishable by in-band checks — unconditional tolerance would admit copied or cloned roots the strict schema exists to refuse.

## Consequences

A copied directory receives fresh inodes by definition, so inode agreement across documents, files, state, and database witnesses is the strongest locally provable evidence of a remount; gating recovery on volume-UUID readability keeps the guarantee that admitted stores immediately acquire the durable witness the strict schema lacked. File copies cannot preserve inodes, so a copied root still fails every witness and is refused. The offline `recoverDocumentIdentityMount` verified-restore path is unchanged and remains the only route when recorded inodes diverge or the host lacks volume UUIDs. Recovery methods never create markers, never accept changed inodes, and each witness is re-verified on its own evidence before any byte is normalized.

## Testing

`mount-recovery.spec.ts` covers an inode-proven legacy remount healing on open with history preserved, refusal without volume evidence, and refusal after inode change; `mount-loader.spec.ts` replays the managed provider healing through the real Loader on a mocked UUID. `identity-fs.spec.ts` continues to refuse file-by-file copies of schema 3 and 4 stores.
