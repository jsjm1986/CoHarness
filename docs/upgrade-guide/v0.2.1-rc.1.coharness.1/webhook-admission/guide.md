---
kind: upgrade-guide
description: "Webhook management retains current administrator authority and delivery reservations bind the current endpoint revision."
---

# Upgrade Webhook admission authority

English | [中文](guide.zh.md)

## Change

Webhook endpoint writes, privileged metadata reads and manual redispatch retain the current active administrator through database work. A withdrawn administrator receives403 without a successful mutation audit or new dispatch receipt.

Provider reservation requires an active organization and the same enabled endpoint revision used for signature verification. Removed or disabled endpoints return404; changed configuration returns409. A rejected reservation consumes no intake budget. Parsed payload values that cannot survive JSON serialization reject with400 before receipt creation. Explicit administrator replay can use a disabled endpoint's current configuration without enabling public intake.

## Migration

1. Upgrade the complete Gateway. Request JSON and database schemas need no migration.
2. Custom endpoint services accept the authenticated administrator id for `list`, `update`, `mutate` and `dispatchConfig`; receipt diagnostics and redispatch carry it as well. Update all callers together.
3. Direct reservation callers register and enable a real endpoint, then pass its current revision, execution account and target. Preserve original receipts across rotation; retry transport with the current endpoint configuration. See the [admission decision](../../../../.agents/notes/implemented/bug-fix/2026-10-29-webhook-admission-authority.md).
