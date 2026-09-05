# Agent Note: A detached history read survives the resume that opening the session triggers

Status: implemented

English | [中文](2026-09-03-history-read-survives-concurrent-resume.zh.md)

## Problem

Opening a large cold session in the Web client failed with "Failed to load history: history storage is temporarily unavailable" whenever the tail page did not fit one persistence page. The client issues `session.history` and the resume of the same session concurrently; the resume appends its lifecycle events (`session/end-seed`, `permission/preset`, `sandbox/mode`, `approval/policy`), which moves the persistence revision while the Host's [bounded detached page walk](../architecture/2026-08-31-bounded-detached-history-pages.md) is still running. The walk observed the move either inside one page read (`dependency`) or through the revision bound into its continuation cursor, which the base `readPage` classified as a caller `protocol` fault, and `historySourceFor` propagated either failure to the client, whose `doOpen` does not retry. Small sessions read one page and never hit the window; the `complex-history.perf.ts` lane and any session longer than ~50 messages hit it on every cold open.

## Decision

`historySourceFor` runs the page walk in `boundedDetachedHistory()` and, on a `dependency` failure, re-reads `ctx.sessions.get(sessionId)`: a session attached meanwhile is served from its resident log, the source the request would have used had the resume finished first; otherwise the walk restarts once on the new revision, and a second move is reported as before. The base `SessionPersistence.readPage` keeps `protocol` for a cursor that names another session or direction and classifies a cursor whose revision no longer matches as `dependency`, the same retryable category it already uses when the revision moves during one page read. The Gateway's conversation page reads (`ConversationRepository.readPage` and the runtime API's compatibility page) apply the same split, so a Host on Gateway persistence receives the 503 `conversation-dependency` response that `GatewaySessionPersistence` already maps to `dependency` instead of a 400 `protocol` it would never retry.

## Alternatives considered

**Retry `dependency` once in the client's `doOpen`.** A second round trip while the resume is still appending can fail the same way, and the client cannot know that the attached log now exists; the Host can switch sources without another request.

**Serialize the resume before the first history read.** Model admission would wait for a full log load on every open, the cost the [live history retention](2026-08-24-live-conversation-history-retention.md) note rejected for prompts.

**Keep the stale-cursor classification as `protocol`.** The cursor binds the revision precisely so a moved log invalidates it; the condition is transient and provider-independent, so callers that recover from `dependency` must see it under that category.

## Consequences

A cold open whose resume wins the race serves the tail from the attached session with no extra persistence read; a log moved by any other writer costs one repeated walk. A revision that keeps moving still fails closed with the existing safe message. Host tests cover the attached fallback (the resume's `session/end-seed` boundary appears in the served page), the single restart, and the bounded retry; the persistence page test and both Gateway page tests pin the `dependency` classification for a moved revision and `protocol` for a foreign cursor.
