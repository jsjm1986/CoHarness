---
kind: upgrade-guide
description: "Account administration checks current authority after waits and before account changes or deletion stops."
---

# Retain current administrator authority for account changes

English | [中文](guide.zh.md)

## Change

Account creation, profile and eligibility changes, role/status updates, password resets and deletion require the initiating administrator's current authority in their database transaction. Valid requests delayed past account, membership, role or organization revocation return403. Rejected creation allocates no account directory; rejected updates retain account fields, credentials and sessions.

Deletion checks current authority before cancelling queued starts or stopping the personal Runtime, and again before deleting account data. A revocation after approved stop intent can preserve a stopped account. The [destructive ownership procedure](../project-deletion-lifecycle/guide.md) continues to govern replacement starts, uncertain stops and cleanup failures.

Management calls require the initiating account’s current password qualification after transaction waits. A password reset committed before admission returns403 for queued work; a missing password record also refuses admission. Already admitted database changes retain their completion response.

## Migration

1. Deploy Gateway writers together using the [existing deployment procedure](../../../../gateway/README.md). No additional schema or Session format migration is required beyond the existing destructive-operation migration.
2. Custom `GatewayUserService` adapters propagate the server-authenticated `actorUserId`: second argument for `create` and `remove`; third for `patch`, `setStatus`, `setRole`, `setDisplayName` and `resetPassword`. Request fields cannot provide the actor. Omission permits trusted bootstrap or maintenance.
3. Validate current administrator authority after password hashing and transaction admission, retaining the account and membership through writes. SQLite adapters use an immediate transaction. Do not retain a database connection through Runtime supervision.
4. Custom instance repositories honor the actor for personal targets as well as projects in `markStopping` and `acquireStopLease`. Keep the existing stable RuntimeId ownership checks and exact release rules.
5. Verify revoked account mutations return403 with unchanged data and Runtime, current administrators still succeed, and self-delete and last-administrator protection remain effective. Read the [authority decision](../../../../.agents/notes/implemented/bug-fix/2026-10-28-user-administration-authority.md) before automating deletion retries.

After a forced password reset, sign in and complete the required password change before retrying management. Custom actor-bearing service callers must supply a currently eligible account; actor omission remains reserved for documented trusted maintenance.
