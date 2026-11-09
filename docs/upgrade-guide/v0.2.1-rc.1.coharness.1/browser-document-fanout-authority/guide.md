---
kind: upgrade-guide
description: Browser document copies to multiple targets retain current administrator authorization on every outbound request.
---
# Browser document fan-out authorization

English | [中文](guide.zh.md)

## Change

Browser copies to multiple project targets require the initiating account to remain an active organization administrator. Every source read, upload request and later target rechecks that role. Demotion stops remaining requests with `DOCUMENT_TRANSFER_MULTI_TARGET_FORBIDDEN`, even when the account retains project write memberships. Completed files remain snapshots; incomplete uploads follow their normal expiry cleanup.

## Migration

1. Keep administrator membership active while a multi-target operation is running. If authority is withdrawn, review the per-target results before retrying.
2. Members with the required source read and target write permissions can continue copying to one target at a time.
3. No configuration or stored-data migration is required. See the [document workbench decision](../../../../.agents/notes/implemented/feature/2026-08-24-cross-scope-document-workbench.md).
