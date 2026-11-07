---
kind: upgrade-guide
description: "Managed document SQLite schema 4 records private directory capture and requires compatible workers."
---

# Upgrade managed directory recovery

English | [中文](guide.zh.md)

## Change

Gateway-managed document identity databases use private SQLite schema 4. Writable opening migrates schemas 2 and 3 without replacing document incarnations, creators, trash actions or catalog delivery positions. Directory recovery records the selected directory object and verified private capture before destination publication. A changed source or occupied destination is preserved; an unsuccessful exclusive rollback retains private bytes and recovery evidence.

Schema 2 pending directory operations remain recoverable when the original source or moved destination is identifiable. An ambiguous operation refuses further mutations while preserving its copies and journal. After a verified directory is published, ordinary file edits reconcile independently and do not prevent rename recovery. Atomic replacements receive a separate unattributed identity; the recorded original creator and rename initiator do not change. Earlier readers reject schema 4. The [volume-identity guide](../document-volume-identity/guide.md) defines persistent volume binding and legacy remount recovery. Immutable schema 2 backup verification remains read-only; restoring a compatible backup migrates its writable copy.

Ordinary external moves retain a uniquely identified file's incarnation and creator when its former name is reused or file addresses are exchanged. Unknown or replaced point reads may scan the full document root. Ambiguous hard-link destinations remain unattributed. Address reconciliation uses the existing schema and wire versions.

Linux x64 and arm64 support exclusive directory moves on musl without a libc `renameat2` wrapper. Unsupported kernels or filesystems still refuse the operation without replacing an occupied destination.

## Migration

1. Stop the Gateway and its document writers. Back up each scope's public document root, private metadata root and private retained-file root together, using the verified deployment backup workflow. Include incomplete uploads and recovery records.
2. Upgrade Gateway and the local document provider together, then start the Gateway. Do not lower SQLite versions or remove journals, private anchors or capture directories. A recovery refusal requires preserving all copies and restoring the original recorded directories before retrying; use a complete compatible backup for rollback.
3. List a managed document scope and rename a selected folder to an available name. Confirm the document keeps its incarnation and creator after Gateway restart. An occupied destination must return a conflict without replacing its files. Refer to the [provider's failure and recovery rules](../../../../packages/attachment/userdoc-local/README.md).
