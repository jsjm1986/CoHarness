# Agent Note: Gateway body migration is server-authoritative

Status: implemented

English | [中文](2026-09-14-gateway-body-migration.zh.md)

## Problem

A Gateway-stored session written at an older Session format version must remain readable and continuable after an upgrade. Lazy read-time migration upgrades only the in-memory view: the stored rows keep the legacy generation, so the first append after resume uses migrated coordinates against the legacy sequence and PostgreSQL rejects it on `expected seq`, leaving the session readable but uncontinuable.

## Decision

`POST /internal/runtime/session/migrate` performs the migration inside one PostgreSQL transaction. The route authenticates the runtime token, applies the same `belongsToRuntime` scope check as other session reads, requires the target header to carry the catalog's current version, and strips the caller-scoped revision prefix before reaching the repository.

`ConversationRepository.migrate` locks root then session in append order, verifies the caller's `version:next_seq` source revision, reads the full stored body, and runs the supplied transform — the same `sessionFormatCatalog` stream the coordinator uses for detached reads, so the committed successor equals what readers already saw lazily. It refuses an already-newer stored version, a stale source revision, a non-contiguous or wrong-version transform output, and records a `conversation_migrations` receipt keyed `UNIQUE(session_id, migration_id)` before rewriting. The committed predecessor rows are copied into `conversation_migrated_events` under the receipt id, matching the file backend's retained-generation rule, then `conversation_events` and `conversation_search` are rewritten and the session row's counters, visible-content fields, seed length, and format version are recomputed in one commit; a child migration recomputes the root mirror. The committed `seedLength` is the migration stream's `finish()` result — the target-generation cut — never the source header's `seedLength`, which a seeded pre-v3 log may legitimately move when generated events extend the inherited region. Concurrent attempts serialize on the session lock: a later arrival with the same migration id reads `current`, and a stale revision fails loudly.

The Gateway persistence adapter declares `supportsBodyMigration` and sends only identity, source revision, target header, and a deterministic migration id — never the transformed body — so the server stays authoritative over stored bytes and large sessions stay within the request limit. The adapter verifies the response `nextSeq`/`seedLength` against its own migrated view and reports a protocol error on divergence, which keeps catalog skew between release lines loud instead of silently splitting the cursor. A missing route on an older Gateway is a compatibility no-op.

## Alternatives considered

**Client pushes the migrated body.** Rejected because request-size limits break on large sessions and the server would have to trust client-computed bytes instead of its own catalog output.

**Persist the migration in legacy coordinates.** Rejected because the migrated body renumbers events; writing current-format events under a legacy sequence leaves a mixed-generation artifact the append check later refuses.

**Add a generation column to `conversation_events`.** Rejected because it complicates every read and append query; a separate preservation table gives the same retained-generation guarantee without touching the hot path.

## Consequences

Old conversations load and continue after the upgrade, the predecessor generation remains recoverable until the session is deleted, and a mismatched deployment fails loudly at the adapter check rather than corrupting stored rows. The cost is one extra runtime table pair and a server-side catalog dependency the standalone Gateway build must link.

## Verification

`gateway/tests/runtime-api.spec.ts` covers route auth, ACL, revision prefix stripping, target-version refusal, and catalog-transform integration. `gateway/tests/postgres.spec.ts` covers the transactional rewrite, preserved rows, idempotent `current` results, stale-revision and gap rejection, the root mirror recompute, and append continuation at the migrated cursor.
