---
kind: upgrade-guide
description: "Project and model writes serialize with account deletion and retired deleted-account configuration is removed."
---

# Account writes serialize with deletion

English | [中文](guide.zh.md)

## Change

Concurrent project membership changes and invitation acceptance cannot recreate access for a deleted account. Account deletion and project mutations use consistent transaction locking. Directory-grant updates recognize confirmed concurrent deletion, without restarting the removed account or reporting that its grants were written. Unknown accounts and unverified failures remain errors.

Invitation acceptance and authenticated user-origin creation also require current active account and organization membership, organization availability and, for invitations, an active project. Requests authenticated before disablement or archival return403 without creating a grant or project. Deleted acting accounts also receive403. Restoring temporary access permits a fresh attempt; logical deletion does not restore the account.

Administrator creation and import require the current active organization administrator before allocating directories. Requests delayed past revocation return403 without registering a project or leaving a new administrator directory.

New invitations also require active recipient organization membership and a currently available project/organization. A cached recipient lookup cannot authorize issuance after those facts change. An unavailable recipient returns409; revoked issuer or scope authority returns403. SQLite eligibility checks and invitation publication are serialized with account changes.

Personal model access, quota writes, intake-token issuance and startup assignment repair use the same account locking. Verified historical execution usage can still arrive after revocation; unproved deleted-user usage is rejected.

## Migration

1. Use the existing [Gateway deployment procedure](../../../../gateway/README.md). Stop older Gateway writers before applying PostgreSQL migrations 073–074 and restarting the matching payload.
2. The migrations remove project memberships and invitations involving already deleted accounts, plus those accounts' model access and personal quotas. Relationships involving only non-deleted accounts, retained account records, project ownership and files, conversations, usage and audit history remain intact. Retained intake credentials can deliver proved historical usage. No manual file move is required.

3. Both first-party user stores provide `GatewayUserService.isDeleted(id)`. Custom adapters can provide it to confirm retained deletion; return false for unknown ids. Consumers of `applyGrantsToUser` handle the `deleted` result alongside `written` and `restarted`. Omission or failed verification cannot classify an account as deleted. See the [deletion decision](../../../../.agents/notes/implemented/feature/2026-08-16-gateway-user-logical-deletion.md).
4. Confirm that deleted accounts are absent from account management while retained usage remains available in historical reports.
5. Custom `GatewayProjectService.create` and `createManaged` consumers pass `actorUserId` for authenticated creation and derive creator, and managed owner, from that identity. An omitted actor is trusted internal maintenance. Browser request fields cannot supply authentication. No additional migration or wire fields are introduced.
6. Custom project-removal routes follow the [deletion lifecycle requirements](../project-deletion-lifecycle/guide.md), including initial stop authority and final catalog authority.
