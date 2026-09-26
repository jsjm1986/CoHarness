# Agent Note: Administrator-owned Auto review eligibility

Status: implemented

English | [中文](2026-09-22-admin-auto-review-eligibility.zh.md)

## Problem

Auto review requires an administrator grant that users cannot give themselves. A grant must survive Gateway restarts and remain distinct from the permission preset selected in a Session. User preferences and shared-project settings cannot own this authority because their ordinary editors are also its consumers.

## Decision

The Gateway user record owns `auto_review_eligible`, exposed as the required boolean `autoReviewEligible`. New accounts and accounts upgraded from schemas without this grant start with false, including administrators. The existing administrator user PATCH and edit dialog grant or revoke eligibility; desktop and mobile lists show the stored grant independently of account status. Non-administrators and project managers cannot use the administrator route. Invalid boolean input rejects the complete patch before any user field changes, and an older user service without atomic patch support refuses the operation.

Each administrative update records its actor and target in the existing audit log and invalidates the target’s access. PostgreSQL migration [031](../../../../gateway/deploy/postgres/migrations/031_auto_review_eligibility.sql) includes the grant column in the existing user-access trigger, so committed revocations reach other Gateway connections through the established outbox and notification channel. This reuses the access-revision mechanism rather than introducing a separate eligibility cache.

A grant does not activate Auto, write a Session permission event, change future-session defaults, or start a runtime. [Runtime execution admission](2026-09-22-auto-review-execution-attribution.md) consumes the grant independently of assignment and still requires the authenticated initiators, active accounts, and existing project and Session ACLs. Project ownership does not convey grant-writing authority, and projects have no second Auto eligibility switch.

SQLite schema v8 stores the same grant as a constrained zero-or-one integer. The read-only SQLite importer accepts v7 with eligibility explicitly false for every account, and v8 with validated explicit values. Importing a malformed v8 record fails transactionally; the source database is not upgraded or rewritten during import.

## Alternatives considered

**Store eligibility in permission defaults or account preferences.** Those settings express a user’s choice, not administrator authority. Combining the two would let a default-setting write grant access or make an administrative grant silently select a Session preset.

**Infer eligibility from the administrator role.** Administrative authority and permission to use Auto are separate decisions. A default-false grant gives the same explicit assignment behavior to administrators and ordinary users.

**Add a project-level eligibility switch.** Existing project membership and Session ACLs already restrict project access. A second switch adds another administrative state without representing the required intersection of the actual initiating users’ grants.

## Consequences

User-row consumers must carry the required boolean; read-only consumers can observe it but gain no mutation method. Grant changes use the existing access invalidation behavior, including runtime invalidation where configured. Legacy v7 imports grant no new authority, while current v8 imports preserve deliberately assigned eligibility.

## Testing

Real Gateway HTTP tests cover administrator grant/revoke, strict input rejection, unchanged unrelated fields, denied personal-user and project-owner requests, audit records, and access invalidation. A PostgreSQL-backed HTTP case observes revocation on a second database connection and checks its durable outbox revision. Import tests cover v7 defaults, v8 preservation, malformed-current rollback, and byte-identical source databases. The user-page tests cover visible state in both layouts and grant/revoke through the existing edit dialog; these component tests do not replace built-browser verification across the administrator page and a real user Session.
