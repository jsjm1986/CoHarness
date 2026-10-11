# Agent Note: V6-era event types rejected by their own migration

Status: implemented

English | [中文](2026-10-10-v6-era-event-admission.zh.md)

## Problem

`sessionFormatV6ToV7` validated every migrated source event against `RELEASED_V6_EVENT_TYPES`, the event vocabulary frozen at the V6 release (the PR-232 snapshot in `extension-identities.ts`). `gateway/scoped-execution` and `gateway/continuation` joined `SessionEventMap` during the V6 era — event-map additions are not structural, so V6 writers legitimately appended them to V6 logs — yet the frozen list predates them. Any V6 log carrying either marker failed migration with `format v6 contains unknown event type`, surfaced through `generationFailure` as `SessionFormatUnsupportedError`, and became `history unavailable for session "…"` at the RPC seam: the session was permanently unreadable even though the installed build understands every type in it. The same frozen list backed `historicalSessionFormatCatalog`'s V6 restore, so a seeded child whose parent log carries a scope marker failed the same way. Production had three such logs.

## Decision

V6 admission asks "could a V6 writer emit this", not "did the frozen released vocabulary know it". `ADMITTED_V6_EVENT_TYPES` = `RELEASED_V6_EVENT_TYPES` plus the two V6-era additions; the migration stage and `namespaceV6OpaqueEvent` use it, and `historicalSessionFormatCatalog` restores V6 artifacts against it. `developer/message` stays foreign: it is V7-native, a V6 writer could never emit it, and an ignorable one in a V6 log correctly namespaces to `plugin:developer/message` as opaque data. Truly foreign required types still refuse. The frozen released list itself is unchanged — a released V6 reader must still reject the scope markers it cannot interpret rather than silently treat a narrowed execution as cumulative authority. Separately, `session.history` now maps `SessionPersistenceNotFoundError` to `session-not-found` and `SessionFormatUnsupportedError`/`SessionPersistenceCorruptionError` to category-specific `internal` messages instead of the catch-all; raw-log paths stay in the warn log.

## Alternatives considered

**Admit the installed `KNOWN_SESSION_EVENT_TYPES` at the V6 boundary.** Rejected: `KNOWN` includes `developer/message`, a type no V6 writer could emit, so an ignorable `developer/message` in a V6 log would be interpreted with V7 semantics instead of staying opaque — the historical-restore contract the catalog tests pin.

**Leave the frozen list as the migration vocabulary.** Rejected: it permanently orphans logs this harness itself wrote; the refusal exists to stop interpreters that lack the semantics, and the migrating build has them.

## Consequences

V6 logs carrying `gateway/scoped-execution` or `gateway/continuation` migrate and read normally; the events keep their type and coordinates into V7. A V6 log claiming `developer/message` or any invented required type still fails with `format v6 contains unknown event type`. The write-open path is unblocked along with reads because both share `requireStoredLog`. The `session.history` public error vocabulary is unchanged (`session-not-found`, `internal`); only the classification of persistence-layer failures improved, and backend diagnostics with raw paths remain server-side.

## Verification

`logical-dialect.spec` migrates a V6 artifact carrying both gateway types and asserts they keep their type while `developer/message` ignorable namespaces to `plugin:` and an invented type still refuses. `v6-gateway-events.spec` opens real V6 artifacts through JSONL persistence: read resolves typed events with the source bytes untouched, write publishes a V7 generation containing the marker, and a foreign-type log still throws `SessionFormatUnsupportedError`. `catalog.spec` restores the two gateway types through `historicalSessionFormatCatalog`. `api-proxy-cold.spec` maps persistence not-found to `session-not-found`, format-unsupported and corruption failures to the category messages, and asserts the raw-log path never reaches the client message. All six production V6 sessions, including the three carrying `gateway/scoped-execution`, open through the real backend with the fix.
