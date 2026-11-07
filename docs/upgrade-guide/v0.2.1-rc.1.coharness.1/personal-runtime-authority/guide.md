---
kind: upgrade-guide
description: "Personal Runtime startup refreshes current account privileges and Admin admission failures use their typed HTTP status."
---

# Refresh personal Runtime authority after startup waits

English | [中文](guide.zh.md)

## Change

Personal Runtime startup resolves the current eligible account after capacity admission and checks its identity, home and role again after node-pressure admission. Changes during preparation return503 before process allocation; a new request can prepare the current role. Warm policy refresh also uses current eligibility and role. Existing revocation and stop convergence still govern already running processes.

Admin Runtime admission errors retain readable `error` text and include `code`. Unavailable policy or capacity returns503 (`INSTANCE_UNAVAILABLE` or `INSTANCE_CAPACITY`); durable stop and resource-generation conflicts return409. Linux account preparation failures return409 `RUNTIME_ACCOUNT_NOT_PROVISIONED` for an absent account or503 `RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE` for an unavailable lookup, with preparation guidance. Clients treating every failed start as400 or500 must handle these statuses.

PostgreSQL activity leases acquire the assignment lock before checking current eligibility. Permission withdrawal during the wait refuses admission. Resource accounting and activity use the configured statement timeout for lock waits; an unlimited statement retains the pool lock timeout. Exhausted contention returns503, including `resource-database-busy` on resource HTTP routes, without automatic replay or reservation release.

## Migration

1. Deploy Gateway writers and launchers together using the [existing deployment procedure](../../../../gateway/README.md). No additional database or Session format migration is required.
2. Custom instance repositories implement `personalPolicy(id)` using current active account, organization membership and node assignment; `snapshotOf(target)` reads assignment, state, port and generation together, refusing ambiguous selectors; `admitLease(target, at, generation?)` checks current eligibility and updates activity atomically. Gateway instance adapters implement `liveEndpoint(target)` with current supervisor and accounting checks. Its endpoint still requires captured-generation activity admission before forwarding. Custom launchers await `beforeAllocation` immediately before process allocation or their native start command.
3. Implement `markExpiredConnectionStopping(target, generation, administratorUserId?)` as a conditional stop-intent update for the exact stale managed connection; local, current and replacement generations must remain unchanged. Preserve supplied administrator authority through the mutation. Re-entry must confirm old-process termination before normal startup issues a fresh credential; never update the running generation's connection binding to recover it.
4. Preserve existing account-revocation and confirmed-stop procedures. A rejected preparation can leave policy files; their presence does not prove a running process or authorize reuse.
5. Verify demotion while queued starts an ordinary Runtime, demotion during policy or pressure preparation refuses allocation, and a new eligible request succeeds with restricted policy. Verify node-lease recovery retains Runtime identity and data while rejecting the old credential, and refuses replacement after unconfirmed termination. Read the [authority decision](../../../../.agents/notes/implemented/bug-fix/2026-10-28-personal-runtime-authority.md) before automating retries.
