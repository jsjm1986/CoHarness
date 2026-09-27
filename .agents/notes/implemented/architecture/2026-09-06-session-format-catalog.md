# Agent Note: Session migration uses one adjacent catalog

Status: implemented

English | [中文](2026-09-06-session-format-catalog.zh.md)

## Problem

Session providers need to classify a stored header before reading its body and need one deterministic migration plan for every released generation. Copying version checks into JSONL, Gateway, and SQLite would allow one provider to accept a generation another refuses, and a second admission implementation would let malformed input through one path that the released readers refuse.

## Decision

`@deepseek-ai/dsh-session-format` owns the provider-independent migration machinery; `@deepseek-ai/dsh-session-format-catalog` compiles the complete released chain v0 → v1 → v2 → v3 → v4 → v5 and is the single admission and migration rule source. Newer generations refuse before body decoding; older generations must traverse every declared edge. Inputs are snapshotted and frozen, and the catalog never writes storage.

Two catalogs share the chain. `sessionFormatCatalog` serves JSONL readers: it decodes released physical rows, applies the released codecs' admission, and restores the current artifact. `sessionLogicalFormatCatalog` serves backends that store decoded headers and event rows (SQLite, Gateway/PostgreSQL, detached coordinator reads): it projects stored metadata onto the released header requirements (`seedLength` spells `isSeeded`; unknown keys refuse), admits the logical event envelope, and streams events through the same released edges and the same current-artifact validation. The v2 edge routes through `coharnessV2ToV3Dialect`, the declared CoHarness database dialect that owns only ordering and normalization — turn-scoped surface carriers before the first `step/start`, request-header-carried system prompts promoted to generated `system/message` nodes, `session/end-seed` markers at or synthesized for the inherited cut — while reusing the released stage's payload admission, reference remapping, canonicalization, and retired-vocabulary renaming.

The pre-v3 edges normalize the historical event vocabulary each generation may carry (legacy message payloads, `start`/`end` replace keys) while advancing the generation marker. `Session` construction itself accepts only the current header version; migration is the storage boundary's job, matching upstream. JSONL atomically publishes the current generation while SQLite replaces event rows and the metadata row in one write transaction; Gateway carries only the target header on its migration wire, so it declares no body-migration support and the coordinator publishes nothing rather than let the server version a header over an unmigrated body. Provider backups remain adapter work; they are intentionally not hidden in this pure package.

## Alternatives considered

**Let each provider own its version chain.** Rejected because independent chains would create divergent refusal and migration behavior.

**Rewrite an artifact during header listing.** Rejected because a header-only read must remain non-mutating and must not create a generation before the body has been validated.

**Import upstream Session packages unchanged.** Rejected because their released header and event types are not the CoHarness persistence contract; this package keeps the reusable planning mechanism while adapters retain local semantics.

**Keep a separate permissive catalog for database rows.** Rejected: a second rule source drifted from the released behavior, admitting fixtures the physical path refuses and skipping the retired-vocabulary renaming the released edge applies. The logical catalog projects the stored dialect onto the same released stages instead.

## Consequences

Provider implementations have one reusable migration planner and a stable diagnostic category; malformed logical input is refused exactly as the physical path refuses it. The catalog itself does not write storage; JSONL and SQLite own their provider-specific publication. Gateway clients issue an optional idempotent migration request carrying the source revision and target header; the server must add the transactional endpoint and rollback contract, while a 404 keeps older deployments on the in-memory fallback.

## Verification

Logical-catalog tests cover header classification and projection, newer-version refusal, unknown header keys, dense-sequence enforcement, dialect normalization and ordering, prompt promotion, seed-cut synthesis, foreign delivery markers, retired vocabulary, malformed probes shared with the physical path, and the streaming form. Coordinator, Gateway, and SQLite contract specs exercise the catalog end to end, including body-rewriting publication and metadata-only successors.
