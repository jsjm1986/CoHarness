---
kind: upgrade-guide
description: Administrative resource policy and steward directory reads refuse administrator qualification withdrawn while the request waits.
---
# Administrator authority for resource reads

English | [中文](guide.zh.md)

## Change

Resource permission GETs for desktop, terminal, SSH, plugin, steward and memory, plus `GET /admin/api/steward`, require current active administrator eligibility at database admission. A request whose role, account, membership or organization is withdrawn while it waits returns403 `forbidden`. Once a reader retains qualification, concurrent withdrawal waits until its read transaction completes. Permission values and revisions are unchanged.

## Migration

1. Clients must handle403 for an in-flight administration read and stop displaying its result after qualification withdrawal.
2. Custom Admin service callers pass the authenticated account id as the second argument to `ResourceAccess.get(owner, actorUserId)` or the first argument to `StewardAccess.list(actorUserId)`. Omission remains reserved for trusted internal reads. Browser actor fields grant no authority.
3. No database or configuration migration is required. Confirm that current administrators can read and that a queued request is refused after committed withdrawal. See the [reader decision](../../../../.agents/notes/implemented/bug-fix/2026-11-05-resource-policy-read-authority.md).
