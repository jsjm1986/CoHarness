# Agent Note: Gateway logical user deletion

Status: implemented

English | [中文](2026-08-16-gateway-user-logical-deletion.zh.md)

## Problem

The admin user page could create, disable, and reset accounts, but it had no deletion operation. Physical deletion is unsafe because projects, conversations, content files, usage records, and audit events retain foreign-key references to users. Leaving a disabled account fully provisioned also leaves sessions, project grants, runtime credentials, and model intake credentials available for accidental reuse.

## Decision

`DELETE /admin/api/users/:id` performs a logical deletion. The Gateway holds confirmed-stop operations for the account's local Runtimes and requires every computer's assignment to be stopped or protected by a matching quiescence receipt before marking the account disabled with `users.deleted_at`. An unresolved remote process refuses deletion. It revokes sessions, clears Runtime credentials, removes project memberships, model-user access, account/Runtime intake tokens and user-specific quotas, and records `admin.users.delete`. Active user counts, lists, username lookup, authentication, internal public-id resolution, directory grants and new intake-token issuance exclude deleted rows. Working directories, private Runtime data, conversations, content metadata, model usage, usage alerts and audit rows remain available for history and recovery; the username remains reserved.

The current administrator cannot delete themself. An active administrator cannot be deleted when it would leave no other active administrator. The same last-admin rule remains in force for disable and demotion. A deleted account is never returned by the admin API, so later mutations receive `404`; a repeated delete is idempotently treated as not found.

SQLite schema version 5 adds `users.deleted_at` to existing databases. PostgreSQL migration 006 adds the timestamp and an active-account lookup index. SQLite import carries the deletion timestamp into PostgreSQL. The PostgreSQL login transaction rechecks and locks the active user row before creating a session, so a concurrent deletion cannot create a fresh session after revocation.

### Concurrent project mutations and grant projection

Project creation, invitation creation/acceptance and membership mutations share-lock non-deleted account rows before taking project or relationship locks. Startup reconciliation holds the same user-row protection through missing assignment insertion, so account cleanup cannot be followed by a stale allocation. Deletion either precedes that lookup or waits for the project mutation to commit, then removes its operational relationships. This order prevents a membership insertion from surviving the account's cleanup and avoids a cycle between invitation-row ownership and the user's foreign-key lock. PostgreSQL migration 073 removes legacy project memberships and invitations involving deleted accounts; project ownership, files and historical conversation, usage and audit references remain intact.

Authenticated user-origin creation and invitation acceptance retain active account and organization-membership rows before their project or node-allocation locks. Acceptance requires an active project and checks organization availability after the invitation lock; authenticated creation checks availability after allocation waiting. Acting-account denial uses a typed403 response, including retained deleted accounts. The Gateway derives the creation actor, owner and creator from the authenticated identity; service actor omission permits trusted internal maintenance. Issuance retains the issuer and recipient account/membership rows before acquiring its project lock, then validates current management authority and scope availability. Unavailable recipients retain the existing user-disabled conflict; issuer and scope denials use403. SQLite keeps eligibility reads, expired-invitation renewal and publication in one immediate transaction. Rejected creation uses the existing [directory-compensation policy](../bug-fix/2026-10-23-project-creation-transactions.md).

Post-transaction directory-grant projection confirms deletion through `GatewayUserService.isDeleted`. Both first-party stores distinguish a retained tombstone from an unknown id. A confirmed concurrent deletion returns `deleted`, without claiming a successful write or restart; unknown accounts and unverifiable failures remain errors. If instance resolution and tombstone verification both fail, both causes are preserved. Filesystem failures retain their existing handling. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/project-account-deletion/guide.md) covers deployment and custom adapters.

### Model configuration and historical usage

Personal model access, quota changes and intake-token issuance share-lock the non-deleted account through their transaction. Deletion either rejects the new write or removes its committed result; a stale lookup cannot recreate that configuration. Migration 074 removes legacy model access and user quotas for deleted accounts. Existing intake credentials remain available for proved historical execution usage; unproved deleted-user usage and model registration are rejected. The normal deletion endpoint removes account and Runtime reporting credentials after every assignment's quiescence is proved. A retained historical credential grants no model dispatch authority.

## Consequences

Administrators can remove access without destroying records needed for audit, usage, collaboration history, or local recovery. Deleted accounts disappear from normal account workflows and cannot restart a runtime or receive new model credentials. Their local home and username remain reserved, so restoring an account requires an explicit future recovery workflow rather than silently creating a new identity with the same name.

## Verification

Focused Gateway tests cover SQLite logical deletion, retained audit rows, removed project memberships, stopped instances, last-admin rejection, API self-delete rejection, runtime stopping, session invalidation, hidden users, and delete auditing. Admin UI tests cover the DELETE request and confirmation dialog. Gateway typecheck and the admin UI production build pass. PostgreSQL integration coverage exercises migration 6 when `HGW_TEST_DATABASE_URL` is configured.

Real PostgreSQL lock tests interleave project membership and invitation acceptance with the actual account-deletion service. A Gateway HTTP snapshot covers overlapping administrator membership and deletion requests without restoring access. Migration checks retain project files, private conversations and model usage while removing retired grants. Grant-projection tests distinguish deleted, disabled and unknown accounts and preserve failures when deletion cannot be verified.

## Alternatives considered

**Physically delete the user and cascade every reference.** Rejected because it destroys audit and usage attribution, removes conversation history, and requires weakening or rewriting durable foreign keys.

**Only mark the account disabled.** Rejected because project memberships, runtime credentials, model access, and intake tokens would remain provisioned and the account would still appear in administrative workflows.

**Allow username reuse after deletion.** Rejected because old audit, conversation, and filesystem records would become ambiguous between two identities; the existing organization-scoped unique username is intentionally retained.
