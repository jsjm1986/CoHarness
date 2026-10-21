# Agent Note: Feedback producers removed; feedback events remain durable log vocabulary

Status: implemented

English | [中文](2026-10-22-feedback-removal-durable-vocabulary.zh.md)

## Problem

The deployment has no consumer for recorded message or session feedback: the sidecar store and Session events were written for a model-quality annotation pipeline that nothing in this fork reads. The feature still cost a thumbs-up/down control on every assistant row, a `/feedback` command, three packages, Remote endpoints, project-scope allowlist entries, and per-release upstream-sync conflict work.

## Decision

Everything that produces or renders feedback is removed: `packages/feedback/command-feedback`, `packages/feedback/message-feedback`, `packages/client/ui-message-feedback`, their Typert remotes, API-proxy route permissions, Cordis bundle registrations, slot-catalog entries, command-menu faces, package tests, and web end-to-end coverage. `upstream-sync.json` records all three packages under `upstreamOnly` so the next upstream sync does not reintroduce them.

The `feedback/record`, `feedback/message-put`, and `feedback/message-delete` declarations stay in `SessionEventMap` — moved from the deleted packages into `packages/core/session/src/types.ts` together with their payload types — because released Session JSONL still carries them. Session-format migrations, the snapshot normalizer, and `session-telemetry-otel`'s explicit-consent authorization keep reading and recognizing the vocabulary exactly as before; the events are log-only records with no `surfaceOp` and no derived-history effect.

## Alternatives considered

**Keep the feature dormant.** Rejected: an unused producer still writes sidecars and events users cannot act on, ships dead UI on every message row, and re-enters every upstream merge as conflict surface.

**Delete the event declarations too.** Rejected: `SessionEventMap` members are required-on-read — unknown types refuse the log — so removing the declarations would make every Session log that already carries feedback events unloadable, and would strip the consent signal OpenTelemetry upload still honors.

## Consequences

Existing `message_feedback.json` sidecars under each user's storage root remain on disk, simply unwritten and unread. Historical Session logs replay, migrate, and export unchanged; explicit feedback events already recorded continue to authorize telemetry upload. No composition ships a `/feedback` command, thumbs control, or feedback Remote, and no new feedback data is produced.

## Verification

`pnpm run typecheck` (host and client faces) and `pnpm vitest run packages/session/session-telemetry-otel packages/test-support/session-snapshot packages/session/session-format` cover the retained vocabulary; generated catalogs, doc graphs, and translation-pairing records are regenerated in the same change.
