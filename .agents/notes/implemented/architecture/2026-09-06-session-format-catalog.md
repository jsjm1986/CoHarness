# Agent Note: Session migration uses one adjacent catalog

Status: implemented

English | [中文](2026-09-06-session-format-catalog.zh.md)

## Problem

Session providers need to classify a stored header before reading its body and need one deterministic v0/v1 → v2 plan. Copying version checks into JSONL, Gateway, and SQLite would allow one provider to accept a generation another refuses.

## Decision

`@deepseek-ai/dsh-session-format` compiles a complete adjacent chain and exposes header-only classification plus detached whole-artifact migration. The default static catalog declares v0→v1 and v1→v2. Newer generations refuse before body decoding; older generations must traverse every declared edge. Inputs are snapshotted and frozen, and the catalog never writes storage.

The current CoHarness steps preserve the existing event vocabulary and advance the generation marker. JSONL now supplies the first provider adapter: a v0/v1 body read atomically publishes `session.v2.*`, preserves the source bytes, and prefers the highest generation on later reads. Gateway and SQLite physical publication, legacy payload normalization beyond the shared coordinator, and provider backups remain adapter work; they are intentionally not hidden in this pure package.

## Alternatives considered

**Let each provider own its version chain.** Rejected because independent chains would create divergent refusal and migration behavior.

**Rewrite an artifact during header listing.** Rejected because a header-only read must remain non-mutating and must not create a generation before the body has been validated.

**Import upstream Session packages unchanged.** Rejected because their released header and event types are not the CoHarness persistence contract; this package keeps the reusable planning mechanism while adapters retain local semantics.

## Consequences

Provider implementations have one reusable migration planner and a stable diagnostic category. The catalog itself does not write storage; JSONL owns its atomic successor publication, while Gateway and SQLite still need adapter-specific publication and rollback work.

## Verification

Catalog tests cover header-only classification, newer-version refusal, adjacent migration, detached output, package typecheck, dependency verification, and release ordering.
