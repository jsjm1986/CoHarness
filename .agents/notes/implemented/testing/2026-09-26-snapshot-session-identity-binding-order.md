# Agent Note: Snapshot session-identity binding order

Status: implemented

English | [中文](2026-09-26-snapshot-session-identity-binding-order.zh.md)

## Problem

Snapshot normalization assigns `{{session:N}}` tokens to session identities, but two independent orders disagreed: the child-log harvest sorted by `createdAt` then recorded id, while replay binds live child sessions to fixture slots in the order the parent log announces them (`catalog` records and `started subagent` tool results). Under parallel subagents the two children can finish in either order, so `createdAt`-ordered harvesting rebound the tokens run to run and produced alternating diffs. A per-frame `sessionIds` reorder cannot fix this: stdout normalization sees one frame at a time and must follow the session-level claim order, so the binding authority has to be decided at harvest time.

A second normalization defect surfaced in the same lane: `session/title-llm-request` carries complete message objects in `data.messages[]`, but they were absent from the durable-message set. Volatile preservation then borrowed the committed `{{message:N}}` token literally into fresh output, reserving its slot and forcing the real message uuids into sparse numbering (5, 6, 7, 8) — a written fixture that is not a normalization fixed point.

## Decision

`{{session:N}}` binds in the order the parent log first announces each child. The harvest in [harness.ts](../../../../packages/test-support/session-snapshot/src/harness.ts) orders child logs by their id's first `catalog` appearance in the parent log, and normalization in [identity.ts](../../../../packages/test-support/session-snapshot/src/identity.ts) claims each log's header and then scans its records before moving to the next log — interleaved per-log claiming, so the parent's `catalog` order wins over the child headers' own order. `childId` is a claimed `SessionId` field so the announcement order itself is part of the binding. The `sessionIds` list handed to per-frame normalization keeps this harvest order verbatim; it is never re-sorted by first-seen position inside a frame, because that would flip tokens between frames.

`session/title-llm-request` records' embedded `data.messages[]` join `recordMessages`, the durable-message set that drives `fixtureMessageIdReplacements`. Their uids borrow the committed uuid — not the normalized token — so `reserve()` no longer pre-occupies a message slot and the remaining durable messages number compactly.

`workspace.expected/` remains authored evidence: record and refresh materialize it only when absent, never rewrite a committed tree. Bootstrap still materializes so a new mutating scenario does not hand-author a directory tree; intentional changes remove the directory before refreshing.

## Alternatives considered

- **Keep `createdAt` ordering for child logs.** The replay binding (announcement order) does not consult `createdAt`, so the two orderings disagree whenever sibling timing crosses; that was the observed flake.
- **Sort `sessionIds` by corpus first-seen position inside normalization.** Per-frame callers see only one frame at a time, so any frame-local reorder makes the same identity claim a different token in different frames.
- **Declare the child order in `snapshot.yml`.** The parent log already carries the binding evidence; a manifest copy can drift from the fixture it describes.
- **Let refresh rewrite `workspace.expected/` like other goldens.** The corpus decision keeps it an independent oracle precisely so a model or tool self-report cannot satisfy the test; session fixtures differ because the recorded input is itself the replay authority.
- **Add `session/title-llm-request` messages to a separate embedded namespace.** Splitting message tokens per record type breaks the single relationship-preserving map the corpus decision requires and renumbers nothing the durable set already covers.

## Consequences

Parallel-subagent fixtures produce one stable token assignment across replay runs; `subagent-parallel` replays identically across repeated runs instead of alternating `{{session:2}}`/`{{session:3}}` bindings. Refresh writes fixtures that are normalization fixed points, so a second refresh is a no-op. Relocating a scenario's workspace oracle still requires deleting `workspace.expected/` first, which keeps workspace changes visible in review.

## Related

- [Session-log snapshot corpus](2026-08-24-session-log-snapshot-corpus.md) owns corpus layout, generation naming, and the shared typed redaction map this order feeds.
- [ACP snapshot tests](2026-06-19-acp-snapshot-tests.md) owns replay and normalization mechanics.
