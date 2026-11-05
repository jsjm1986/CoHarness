# Agent Note: Model administration retains current authority and target lifetime

Status: implemented

English | [中文](2026-10-29-model-administration-authority.zh.md)

## Problem

An administrator request can wait after HTTP authentication and reach model configuration with a revoked role. Organization discovery can decrypt a stored company key and send a catalog probe under that stale authority. Conflicting Provider and organization-revision lock orders can abort concurrent editor saves. Target projects can archive during writes, and SQLite accepts numeric quota aliases that its quota reader never selects.

## Decision

The [administrative HTTP adapter](../../../../gateway/src/admin-api.ts) passes its authenticated account id to every catalog, Provider, credential, access and quota mutation, and to discovery preparation. Caller-supplied actor fields grant no authority. PostgreSQL retains an active organization and its current active administrator account and membership until commit; SQLite checks its current administrator inside the immediate write transaction. Permission loss rejects with403 before configuration, revision or successful-action audit changes. Failed HTTP attempts retain their actual status in audit.

All PostgreSQL model-configuration writers acquire the organization revision row with `FOR NO KEY UPDATE` before actor, target and Provider locks. This order includes project Provider and credential writers because they also advance that revision; their independent [manager authority](../feature/2026-08-28-project-scoped-settings-management.md) remains required. The weaker organization lock permits foreign-key key-share checks while another transaction archives a project or deletes an account. Configuration writes use the caller's single transaction connection.

The utility digest selector uses the same retained administrator for reads, pinning and clearing. Candidates and validation join catalog and Provider rows inside the owning organization. Pinning accepts an exact offered identifier, including spaces in its model id. Organization writer serialization precedes actor and eligible catalog/Provider locks, so a queued pin cannot retain a route disabled before admission. Its accepted setting and candidate view return from that transaction, before a successor's save can change them.

Administrative access and quota writes retain a nondeleted target account or active target project through commit. Disabled accounts remain configurable. SQLite quota writes canonicalize an accepted numeric account id to its decimal text, matching reads and account cleanup. Quota replacement, restored inheritance and account deletion remove that account's historical numeric aliases within the same transaction. Zero, unlimited, and supported inheritance modes retain their meanings.

SQLite import preserves effective quota selection: only a canonical decimal account key supplies an override, and dormant numeric aliases increment `skippedQuotaAliases`. Import replay replaces quota overrides only for accounts present in that source, including restoring inheritance when no canonical override exists. PostgreSQL-only accounts retain their limits. Invalid numeric keys or missing account references roll back the entire import. The frozen SQLite source remains unchanged; an alias alone never activates a limit during migration.

Shared management admission also checks [required password changes](2026-10-28-user-administration-authority.md) after authority waits. Resetting the initiating account cannot leave queued model configuration, credential or quota writes authorized by an earlier browser session.

Organization discovery checks current administrator authority before reading either stored credentials or a supplied draft key. Endpoint-matched stored keys remain write-only. Preparation releases its transaction before the external catalog request; later revocation does not cancel an already dispatched probe. Before returning model metadata, the HTTP adapter uses the [read responder](2026-11-05-administrator-read-publication.md) to recheck current administrator qualification. Changes to role, account, membership, organization or required password updates return403 without publishing the catalog. Committed configuration precedes policy-file refresh, whose [current account authority](2026-10-29-model-policy-authority.md) remains independently checked. Omitted governance service actors permit trusted internal maintenance; HTTP adapters always supply one. Digest administration requires an actor.

## Alternatives considered

**Reuse the HTTP administrator snapshot.** A role or membership can change during database checkout or lock waits, so it cannot authorize the eventual mutation or credential preparation.

**Lock each Provider before advancing the organization revision.** Organization editor writes already need the revision first; the inverse order permits a deterministic deadlock between those operations.

**Hold the preparation transaction during discovery.** The remote server does not participate in the database mutation. Retaining that connection would occupy the pool and delay permission changes for the duration of network work.

**Normalize every imported numeric quota key.** SQLite never selected alias rows for effective limits. Activating them on import changes policy, and conflicting aliases have no durable write order that identifies an authoritative replacement.

## Consequences

HTTP request fields and database schemas are unchanged. Custom governance adapters must retain the supplied actor and current target authority through their own mutations. Organization writers serialize across projects, trading parallel configuration throughput for consistent revision and lock ordering. Configuration commits do not depend on subsequent file projection or network success.

## Verification

Actual SQLite and PostgreSQL Gateway transcripts cover administrator demotion, current administrators, deleted account targets, archived project targets, numeric quota aliases, stored and explicit discovery keys, policy refresh and audit outcomes. PostgreSQL row-lock tests cover account, membership and organization withdrawal, foreign-organization actors and target archive waits. A Provider trigger and advisory barrier reproduce the former lock-order deadlock. Real import-command transcripts retain effective quotas across replay and preserve frozen source bytes. Digest HTTP replays isolate same-key Providers across organizations and exercise opaque candidate ids. Row barriers cover competing pins, eligibility withdrawal and accepted-view ownership. Stored-key discovery uses a local HTTP server; no real model API is required.

Catalog HTTP response barriers cover fourteen late qualification withdrawals with stored and explicit draft credentials. Admitted probes complete without retaining a transaction; their metadata remains unpublished after withdrawal.
