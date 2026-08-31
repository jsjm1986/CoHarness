# Agent Note: Two-tier conversation history transport

Status: implemented

English | [中文](2026-08-18-conversation-history-tier.zh.md)

## Problem

A public Web session's first `session.history` call with `maxMessages: 50` can return tens of thousands of expanded events, almost all `assistant/chunk`, and take tens of seconds on the Cloudflare path. [Lossless history wire pagination](2026-08-14-lossless-history-wire-pagination.md) packs those chunks and cuts the Fetch envelope near 128 KiB, but the browser still expands every historical chunk before Chat can render. Chat finalizes from `assistant/message`; Trajectory and inspect timing need the chunks. Persistence, `deriveMessages()`, compaction, and `session.prompt` already use the full Host log and do not wait on the browser download.

## Decision

`session.history` and `subagent.history` accept `detail?: 'conversation' | 'full'`. Missing `detail` and `'full'` return every event on the already-paginated page. The Web `Session` requests `conversation` on `open()` / `loadOlder()` unless that session already filled detail. The Host obtains cold pages through the indexed persistence `readPage` primitive when available, keeps the detached range within the page and materialization budgets, then omits eligible historical chunk runs from `events` and reports them as `omittedSpans` so the client keeps a hole-free seq ledger. Providers without a seek page implementation retain the compatibility inspection path. Trajectory, Chat inspect handoff, and a persisted `view === 'trajectory'` restore request `full` for the same window and merge by seq. Fetch continues to pack whatever chunks remain.

`omittedSpans` are inclusive `{ startSeq, endSeq }` ranges of omitted historical chunk runs; the field is absent or `[]` when nothing was omitted.

The split runs after `historyPage()` / `paginate()`, so message-group cuts, compaction pairing, tool `view`, and tail projections do not change. The helper keeps every non-chunk event; keeps chunk runs that belong to a group with no append-origin `assistant/message` (in-flight tail and interrupted partials); omits chunk runs under a completed append-origin `assistant/message` (`sourceEventSeqs` / group start, same rule as pagination); and emits coalesced `omittedSpans` in seq order. Unknown non-chunk types pass through. `SESSION_FORMAT_VERSION` stays `0`.

The client window is a logical span: `baseSeq` / tail seq are min/max over loaded event seqs **and** `omittedSpans`. Continuity and gap repair compare against that logical tail, not `events[events.length-1]`. Live mux chunks still append. `prompt()` stays ungated on `openState`. Detail fill uses the same `beforeSeq` / `maxMessages` as the installed window, `detail: 'full'`, merges by seq (existing entries win), then `replaceWindow` once; `omittedSpans` clear for covered ranges. Because `full` still hits the packed byte target, fill walks older suffixes until the current window's spans are covered. While fill is in flight, Trajectory shows a loading state; Chat stays on the conversation-tier snapshot. TTFT / tokens-s that need `firstTokenTime` from chunks stay absent until fill.

### Verification

Host tests pin conversation omit, in-flight and interrupted keep, `full`/missing-`detail` no-ops, span coalescing, suffix clipping, and unknown-type pass-through. Fetch and connection tests round-trip `omittedSpans`. Session tests pin the logical ledger, `loadOlder` continuity, gap-repair skip, seq merge fill, and a sendable composer during conversation-tier loading. The keyless assembled-Web scenario `apps/web/tests/lossless-history-wire.e2e.ts` asserts the first browser `session.history` uses `detail: 'conversation'` with omitted spans, Chat goldens without historical packed chunks, Trajectory fill with `detail: 'full'`, and a persisted `view=trajectory` boot that fetches detail without a second click.

## Alternatives considered

**Delete, skip-persist, or compact away `assistant/chunk` on the server.** Rejected: high-fidelity replay, partial failed streams, and snapshots still depend on persisted chunks ([assembled-assistant-messages-only](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md)). This change is transport-only.

**Stream the 6 MB expanded page and hope compression or a spinner is enough.** Rejected: the measured delay is UTF-8 JSON size on the public path; Chat does not need historical chunks to render finalized messages.

**Omit chunks without `omittedSpans`.** Rejected: the client treated the last loaded event seq as the window tail and required `loadOlder` continuity `tail.seq + 1 === baseSeq`. A hole looks like a mux seq gap and would refetch the huge page.

**Default `detail` to `conversation`.** Rejected: in-process, ACP, and tests that omit the flag must keep today's full event page.

**Change `session.prompt`, `deriveMessages()`, compaction, or model context.** Rejected: those paths already read the Host log; the browser download is not on the send or model-context path.

## Consequences

Chat opens on a conversation-tier page instead of expanding every historical chunk. Trajectory, inspect handoff, and a persisted Trajectory view pay for `detail: 'full'` and merge by seq; a second open is a no-op once spans are empty. Fill still walks packed `full` pages under the 128 KiB target, so a Trajectory open on a huge window issues several history RPCs instead of one 6 MB envelope. Conversation-tier Chat omits TTFT until fill. Treating omitted spans as a mux gap would reintroduce the original download. Persistence, `SESSION_FORMAT_VERSION`, prompt, and model context stay unchanged. The Python SDK has no `session.history` surface and is out of scope.

Related owners: [lossless history wire pagination](2026-08-14-lossless-history-wire-pagination.md), [packed chunk rows](2026-07-26-packed-chunk-rows-by-default.md), [human-transcript append-origin pagination](../bug-fix/2026-07-29-human-transcript-append-origin.md), and [Conversation assembly](2026-08-09-client-conversation-node-assembly.md).
