# Agent Note: Recover transcript receipts through older history pages

Status: implemented

English | [中文](2026-11-25-transcript-receipt-history-recovery.zh.md)

## Problem

A transcript submission echo retires only after its durable `user/message` confirms the browser-owned `requestId` ([pending-submission echoes](../feature/2026-08-30-web-pending-submission-echo.md), [input echo admission ownership](2026-10-13-input-echo-admission-ownership.md)). The live-frame path loses that receipt when the downlink is muted or disconnected at admission time. Reconnect repair reads only the fresh tail page, so a large turn can place both the admission receipt and the user's durable message before the resident window. The composer then stayed in `submitting` forever even though the Host had accepted the input and the assistant reply was visible.

The bounded live-window decision intentionally stops automatic expansion for an idle session and forbids a tail probe from recreating `hasMore` after a complete window ([bounded live window and incremental reconnect](2026-09-03-bounded-live-window-and-incremental-reconnect.md)). That rule is correct for a nonempty complete window, but a fresh session begins with an empty complete window. Once later input and tool output overflow one page, the recovered tail really does have an older prefix even though the resident window's earlier `hasMore: false` fact was accurate when captured.

## Decision

A tail merge after an empty resident window may adopt the page's `hasMore`: the empty window contributed no overlapping predecessors, so later admission can create history before that tail. A nonempty complete window keeps the previous no-resurrection rule.

After a fresh open, stage re-entry, or successful gap repair, `Session` checks for an unadmitted transcript echo. When the window base shows older history, it performs one bounded backward walk over contiguous older pages, capped by the existing `MAX_HISTORY_EXPANSION_PAGES`. The walk is serialized with other history mutations but does not publish each page as it arrives. If a page carries a matching user-source `rpcId`, the collected contiguous batch is prepended once, the durable message replaces the local echo in the transcript, and the existing admission observer retires it exactly once. If the walk reaches the log head, a discontinuity, or the bound without the receipt, it discards the pages; absence is not treated as refusal because admission may still be in flight.

The recovery walk counts pages it installs against the live-history retention budget. It does not make queued or steering echoes depend on transcript history: those placements already have queue publications and splice outcomes as their admission surfaces.

## Alternatives considered

- **Rely on the running live-history expansion** — the expansion starts only for a running staged session and can finish before a large turn creates an older page. The failing scenario reconnects after the Host turn is already idle.
- **Use only `session.promptStatus` or managed durable admission** — the managed receipt path remains the stronger cross-computer mechanism, but ordinary local submission must also reconcile through the durable log. The receipt-walk also works with the existing user-message evidence that the history API already exposes.
- **Scan without installing pages** — this would clear the composer but remove the user's visible message when the local echo disappeared. Prepending the contiguous batch preserves the transcript instead of leaving only the assistant reply.
- **Install every scanned page even when no receipt is found** — a rejected or still-pending input could then grow the resident window by dozens of pages with no user benefit, reintroducing the memory cost bounded history removed.

## Consequences

A lost downlink no longer strands an accepted first prompt behind history pagination. The durable user message returns to the transcript rather than merely clearing the echo, and `hasMore` again reflects the older prefix created after an initially empty session. Recovery costs at most 64 older-page reads and runs only while an unadmitted transcript echo exists; normal sends settle through live or queue evidence and start no walk.

A receipt farther back than the bound, or one whose history chain is discontinuous, still requires a later reader action or a newer recovery mechanism. The walk cannot prove non-admission from absence, so it leaves the echo pending rather than risking a false failure while admission is still in flight.

## Verification

`packages/client/runtime/tests/session.client.spec.ts` covers the empty-window `hasMore` transition and a reconnect whose tail begins after the receipt: the recovery walk requests the older page, prepends it, retires the echo as observed, and preserves the tail rows. The keyless Playwright `submission-history-receipt` scenario passes against the real Host and production pagination after muting the downlink through turn completion.

## Related

- [Web pending-submission echoes converge by request identity](../feature/2026-08-30-web-pending-submission-echo.md)
- [Input echo admission ownership](2026-10-13-input-echo-admission-ownership.md)
- [Bound the live history window and make reconnect catch-up incremental](2026-09-03-bounded-live-window-and-incremental-reconnect.md)
