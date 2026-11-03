# Agent Note: Lossless conversation text and event query fields

Status: implemented

English | [中文](2026-10-30-conversation-nul-search-and-query-fields.zh.md)

## Problem

Session JSON can contain NUL, while PostgreSQL text and jsonb cannot. Search insertion shares the append transaction, so an unsupported indexed character can roll back the original body. A guard that excludes an entire NUL-bearing event also removes otherwise valid member activity, question correlation and progress material.

## Decision

Migration100 retains ordinary search text unchanged. A NUL-bearing row stores its original NUL-separated pieces and a line-feed-separated trigram cache. Literal patterns match consecutive original pieces, including empty pieces; fuzzy alternatives use the cache. Literal matches retain priority. Native-json result scalars reconstruct original text and bounded previews without decoding NUL into PostgreSQL text. The same representation applies to live and archive indexes.

The [version-one projection](../../../../gateway/src/postgres/conversation-query-fields-v1.ts) derives turn numbers, numeric participant identities, actor labels, tool-call ids and question arguments in JavaScript. Free-text scalar values are JSON-encoded inside jsonb fields and returned through native json, so PostgreSQL never navigates a NUL-bearing body. Call ids containing NUL cannot name PostgreSQL interaction claims and have no correlation field. Original event JSON, sequence numbers, payload lengths and Runtime assignments remain unchanged.

The migration runner applies the schema and bounded JavaScript backfill in one transaction before recording version100. An exclusive table lock protects legacy unassigned rows while their existing Runtime-required write check is suspended for derived-field updates and restored. Failure rolls back both schema and derived records. Future projection changes use a successor version and forward migration.

Progress request inputs, request Sessions and digest content use native json. Request Session identity checks inspect a NUL-normalized structural view; the stored artifact retains its original values. The immutable-artifact trigger compares original JSON bytes and rejects replacement. Full model inputs remain reconstructable from the recorded Session.

## Alternatives considered

**Replace NUL in the original index value.** Rejected because a line feed, replacement character or literal escape has distinct search semantics.

**Omit affected indexes or events.** Rejected because accepted messages must remain searchable and eligible for shared activity and progress.

**Navigate the original event as jsonb.** Rejected because conversion rejects the same valid NUL values.

## Consequences

Gateways sharing the database use the matching runner and schema. SQL consumers read original index values through the reconstruction helper rather than treating the trigram cache as original text. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/conversation-nul-text/guide.md) owns deployment steps. The [literal-search decision](../bug-fix/2026-10-25-gateway-literal-conversation-search.md) and [Runtime identity decision](2026-10-30-postgres-session-runtime-namespace.md) remain active.

## Verification

Real PostgreSQL checks cover all indexed roles, literal NUL boundaries, wildcard escaping, Unicode previews, generation preservation, legacy bytes, failed second-batch rollback and unassigned write refusal. Runnable Gateway HTTP and dual-computer digest transcripts cover exact bodies, activity, question correlation, request Sessions, citations, usage ownership and replay.
