# Agent Note: Participant-readable ACL for session-query tools

Status: implemented

English | [中文](2026-10-17-session-query-participant-acl.zh.md)

## Problem

Working-directory equality identifies a filesystem context, not a participant's right to read a conversation. Members in a Gateway project runtime share one project directory, so a `cwd`-only check cannot protect private conversations. A readability check taken before asynchronous corpus, event, title, or auxiliary-model work can also become stale before the result reaches the caller.

## Decision

[`dsh-tool-session-query`](../../../../packages/session-query/tool-session-query/README.md) requires each cross-session target to share the caller's `cwd` and, when `collaboration` is composed, appear in `collaboration.capture().readableSessionIds(ids)`. Personal participants retain their existing readable set; compositions without collaboration retain the directory rule. The caller records whether collaboration was present at operation start; losing that provider before final authorization refuses cross-session output instead of applying standalone directory-only rules. A failed principal capture denies cross-session access while preserving self access. Readability-provider failures pass through the model-safe service-error sanitizer.

The [authorization helpers](../../../../packages/session-query/tool-session-query/src/workspace-access.ts) batch candidate ids at each operation stage. Search resolves one workspace admission set and reuses it across provider pages, parent filters, and title observations. Session tracing checks one complete lineage batch and masks unreadable ancestor and descendant subtrees without exposing their ids. Exact target tools authorize before reading their target.

Each [operation](../../../../packages/session-query/tool-session-query/src/operations.ts) obtains a fresh readable set after its asynchronous reads and immediately before formatting the result. This final batch covers every disclosed cross-session id, including visible search-hit parents, ancestors, descendants, and titles; a revocation rejects the complete result with `SESSION_QUERY_TOOL_UNAUTHORIZED` and returns no already-read content. Handoff also checks before auxiliary-model extraction and after extraction completes. Self access does not require a cross-session check, and no operation makes one request per hit.

## Alternatives considered

**Keep `cwd` equality as the sole check.** It carries no visibility information and cannot distinguish private and shared conversations inside one project directory.

**Authorize each record inside synchronous filters.** Readability is asynchronous; per-record checks multiply Gateway requests by result count. Batched admission and final publication checks bound the number of tool-level calls independently of hit count.

**Check readability only before search or target lookup.** Trace and event reads can reach the same data, and asynchronous reads can finish after a revocation. Every operation owns both admission and final result authorization.

**Reject all work when no principal is bound.** Ambient turns may inspect their own Session. Failing cross-session checks closed preserves that self path without granting access to neighbors.

## Consequences

Collaboration-aware search adds one workspace corpus enumeration and a final readability batch for the ids actually disclosed. Trace and exact reads also pay a final batch; handoff pays an additional check before auxiliary inference. A source that becomes unreadable during a call produces a whole-operation refusal rather than a partial result.

The final authorization response is the publication check; it does not provide a cross-process transaction with later ACL changes. Data sent to an authorized auxiliary model before revocation cannot be retracted, but a revocation observed after extraction withholds its result from the caller.

## Verification

[Package regressions](../../../../packages/session-query/tool-session-query/tests/tool-session-query.spec.ts) cover denied targets, masked search parents and lineage, missing principals, sanitized provider failures, and deterministic revocation while title, provider-page, surface, or extraction work is paused. The [headless recorded-session scenario](../../../../snapshots/session/session-query-acl-revocation/snapshot.yml) boots the shipped profile with real query tools and a controlled external ACL response; its transcript records a refusal and excludes the private source body. Removing final ACL verification makes that assembled scenario fail.
