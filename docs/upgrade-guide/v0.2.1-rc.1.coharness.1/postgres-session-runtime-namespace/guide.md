---
kind: upgrade-guide
description: "PostgreSQL Session identity, cursors and empty-draft requests require Runtime qualification."
---

# Upgrade Runtime-qualified PostgreSQL Sessions

English | [中文](guide.zh.md)

## Change

PostgreSQL migration099 replaces global Host Session keys with organization/Runtime/Host identity. Equal original Host ids, append batch ids and interaction ids can coexist in independent Runtimes. Existing assignments and event bytes survive; unassigned history and unwitnessed reservations remain independent legacy data. Newly allocated Runtimes cannot claim them.

Empty-draft preview returns each candidate's `runtime.runtimeId`. Trash requests replace `ids` with `sessions: [{ rootSessionId, runtimeId }]` and retain the preview's `cutoff`; `trashed` returns the same pairs. Missing, malformed or duplicate pairs return400. Another computer's pair makes no change. Archive-record routes continue using `archiveId`.

Session page cursors and project-activity cursors include their Runtime. Old page cursors are refused; unqualified activity cursors restart at the first page. Notification payloads include `runtimeId`; native clients require it instead of opening an equal Host id in the selected Runtime. Released JSONL generations are unchanged.

Project sharing reads and visibility changes send the Session’s `dshRuntime`, `dshTarget` and `projectId`. Keep these selectors with the Session when another tab changes its space; a shared scope cookie cannot identify the requested Runtime.

## Migration

1. Stop every Gateway sharing the database and retain a restore-checked backup. Upgrade all Gateway payloads together, including managed computers. Startup applies migration099; do not run older SQL writers against it or downgrade the migrated database.
2. Deploy the matching Admin UI and native/Web payloads. Custom maintenance clients retain each preview pair through confirmation and inspect the returned pairs. Clear old pagination state and reload after upgrade. Old notifications without a Runtime do not open a Session.
3. Custom storage consumers construct `PostgresConversationStore.forRuntime({ organizationId, runtimeId })` from authenticated allocation metadata. Collaboration, push and steward calls carry that same Runtime. Do not infer it from a Host id or a new allocation.
4. Confirm that equal Host ids in two Runtimes retain independent bodies, retries, approvals and cleanup. Verify legacy event bytes and ownership before and after migration, including unknown records. Confirm that selecting one same-name draft preserves the other. See the [Gateway reference](../../../../gateway/README.md) and [identity decision](../../../../.agents/notes/implemented/architecture/2026-10-30-postgres-session-runtime-namespace.md).
