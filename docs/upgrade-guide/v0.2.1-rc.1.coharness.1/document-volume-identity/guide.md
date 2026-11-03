---
kind: upgrade-guide
description: "Managed document SQLite schema 4 and native filesystem UUIDs require matching Gateway and native packages."
---

# Preserve managed document identity across remounts

English | [中文](guide.zh.md)

## Change

Gateway-managed document metadata uses SQLite schema 4 and private domain marker version 2. Writable opening migrates schemas 2 and 3; immutable backup verification remains read-only. macOS stores descriptor-derived filesystem UUIDs alongside original directory inodes. An unchanged volume and directory permit device-number normalization without replacing document incarnations, creators, trash actions, pending changes or delivery cursors. Copies and changed volumes require verified restore. Hosts without persistent UUIDs retain strict device/inode checks.

Older stores have no persistent volume evidence. A device-number change before UUID acquisition remains a visible refusal; inode equality alone does not authorize automatic migration. Earlier workers cannot read schema 4. Session JSONL format and public document references are unchanged.

## Migration

1. Stop Gateway document writers and runtimes. Preserve each current scope's public documents, private metadata, retained files and incomplete uploads together. Keep verified backups immutable, and preserve retired scopes independently.
2. Upgrade Gateway, `@deepseek-ai/dsh-userdoc-local`, and matching `@deepseek-ai/node-addon-system` JavaScript and native payloads together. The native operation requires version 0.1.4 or later; preserve the platform and libc selection. Start the Gateway only after the matching files are present.
3. For a legacy device-number refusal, keep writers stopped. If every storage location supplies a persistent filesystem UUID, an authorized offline operator may call `recoverDocumentIdentityMount(locations, { databasePath, entries })` for the current active scope. `databasePath` must name the original metadata member in an independently verified pre-remount deployment backup; `entries` must retain that snapshot's original absolute membership, object witnesses, sizes, modification times and SHA-256 digests. Every currently recoverable version must still match. The recovery preserves later purge history and partial uploads. Missing UUIDs or evidence, or changed current versions, require a complete compatible restore; never rewrite device numbers manually, downgrade SQLite or remove private markers.
4. After successful recovery, start a fresh managed runtime. Confirm document incarnations and creators, retained trash and owned partial-upload progress survive restart. A different account must still be unable to resume another account's upload. On interruption, keep the scope unavailable and retry with the same independent evidence. See the [provider's recovery rules](../../../../packages/attachment/userdoc-local/README.md).
