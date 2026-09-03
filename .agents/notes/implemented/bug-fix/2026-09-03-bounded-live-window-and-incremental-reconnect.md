# Agent Note: Bound the live history window and make reconnect catch-up incremental

Status: implemented

English | [中文](2026-09-03-bounded-live-window-and-incremental-reconnect.zh.md)

## Problem

The Web client felt slow on long conversations, and slower the longer a session ran. Five independent mechanisms multiplied: the [live history retention](2026-08-24-live-conversation-history-retention.md) expansion fetched every older conversation page as soon as a staged session ran, so the resident window grew from one 50-message tail to the whole log (up to 64 pages) and every later stream publication rebuilt and reconciled that node count; `TrajectorySnapshotBuilder.apply()` rebuilt every ledger array and map from scratch on each publication, including while the Trajectory tab was hidden, and published new identities that invalidated every layout memo in `TrajectoryView`; `ChatView` hit-tested the flow with four `elementsFromPoint` probes on every scroll event, including the scroll event its own follow write delivered on each publication; a connection loss reset every open window (`events = []`, `openState = 'cold'`) and, for a running staged session, restarted the full expansion, which a Gateway deployment triggers every 30 seconds when the signed principal expires; and each stream frame was serialized twice on the Host (byte budget, then carrier) and copied once more in the browser only to count its bytes.

## Decision

The live expansion retains at most `LIVE_HISTORY_RETAINED_PAGES = 3` older pages behind the tail page, tracked by `Session.liveHistoryPages` and reset with the window (`leaveStage`, `installWindow`). A running staged session therefore holds at most 4 × `PAGE_MESSAGES` messages resident; `beginLiveHistory()` is a no-op once the bound is reached, so later prompts and running edges do not extend the window. A walk that reaches the log head still lands in `historyWindowMode: 'live'`; a bounded walk returns to `'tail'` with `hasMore: true`, so the older-page control and near-head automatic paging resume after the turn. `MAX_HISTORY_EXPANSION_PAGES` remains the bound for reader jumps (`loadHistoryUntil`) and detail fills.

`Session.resync()` keeps an open window. Durable events never change, so a reconnect clears only pending interaction waits and the subscribed baseline, then runs the gap repair: one tail read merged into the resident window without bumping the open generation, because an in-flight page request is still valid history. Only a window that was still loading or in error is reset and reopened. `repairGap()` is awaitable and coalescing: a request made while a repair is in flight makes the running repair read the tail once more instead of being dropped by the stitching guard. `mergeTail()` appends in place when every missed event lies past the tail (the ordinary reconnect case, node identity preserved), merges by sequence when the page also covers an older prefix, and replaces the window through `installWindow()` only when the tail's logical base no longer touches the window because the stream was down for longer than one page covers; a running staged session then restarts its bounded expansion. A `session/subscribed` baseline past an open window's tail triggers the same repair, so a session that went idle while the stream was down catches up without waiting for its next live event.

`TrajectorySnapshotBuilder` distinguishes a publication that moved only an Assistant's streaming partial (same settled node, shallow-equal request) from every other change: the former swaps the `partial` field on the previous snapshot; the latter rebuilds the ledger but reuses the previous element for every row whose content is shallow-equal (matched by `seq` or `startSeq`), the previous array when no row changed, and the previous `eventLocations` and `callSchemas` maps when their entries are identical.

`ChatView` samples reader geometry (the visible row that names the active turn, the pending prepend anchor, and the saved scroll position) at most once per `SCROLL_SAMPLE_INTERVAL_MS = 500` with one trailing sample, samples immediately while a prepend is pending so the arriving page preserves the reader's latest row, and never hit-tests for a follow write: when the scroll event is the ledger's own programmatic write while pinned, the tail node names the active turn.

`serverRequestJson(frame)` in `dsh-host-apiproxy/api` serializes the wire `ServerRequest` envelope once per frame object in a `WeakMap`; `FrameQueue` accounts bytes from it and both carriers (`WebSocketDownlinks.send`, the SSE handler) write the memoized text. The browser downlink budgets a text frame by its UTF-16 length, a lower bound of the UTF-8 bytes the Host admitted, instead of re-encoding it. `projectAssistant()` in `ui-conversation` memoizes one projection per (state object, start Location) pair so the step-scope Location data and the view node of one flush share it.

## Alternatives considered

**Keep the complete live window and virtualize the Chat list.** Virtualization bounds the DOM but not the per-publication assembler, snapshot, and reconcile work over thousands of nodes, and it is a large change to a view whose paging anchor, follow scroll, and turn navigation all depend on real row geometry. Bounding the window removes the multiplier at its source; virtualization remains a separate, optional improvement.

**Hide the older-page control while running instead of retaining any pages.** The 2026-08-24 note rejected this because the active transcript stayed incomplete. Retaining three pages keeps the recent transcript readable during a turn while bounding cost; the control reappears only for history beyond that bound.

**Reset the window on reconnect but skip the re-expansion.** The reset still discards the reader's position, rebuilds every Context, and remounts every row on each 30-second Gateway reconnect. Merging one tail read costs one request and leaves unchanged rows untouched.

**Bridge a long outage page by page instead of replacing the window.** Walking back from the fresh tail to the stale window replays exactly the unbounded work this note removes, for a rare case. Replacing the window pays the same cost as a stage re-entry and only when the outage outlasted one page.

**Make `TrajectorySnapshotBuilder` fully incremental with per-row indexes like `ChatSnapshotBuilder`.** The ledger's post-passes (compaction interruption, turn errors, header inheritance) read the whole ordered list, so a structural change still needs a rebuild. Reusing content-equal rows and arrays after the rebuild gives the view the identity stability it needs without duplicating the ordering logic.

**Extend the Gateway principal TTL or stop aborting streams at expiry.** Both change the security model that the Gateway owns; the deployment can still raise `HGW_PRINCIPAL_ASSERTION_TTL_MS`. This note makes each reconnect cheap regardless of its cause.

## Consequences

A running long session pays for at most four pages of nodes per publication instead of the whole log, and a reconnect costs one tail read plus the missed rows instead of a window rebuild and a re-expansion. Trajectory memos survive a stream, and Chat forces at most two layouts per second from scroll handling. Large tool results are serialized once on the Host and copied once fewer in the browser.

History older than the retained pages is one older-page request away after the turn and is not shown during it; a reader who scrolls to the head of the retained window mid-turn sees no paging control until the turn ends, as before. A reconnect after an outage longer than one page replaces the window and drops the reader's position, the previous behavior for every reconnect. The browser byte budget admits frames whose UTF-8 size exceeds their UTF-16 length; the 1024-item cap and the Host's own 8 MiB budget remain.

Runtime tests cover the bounded expansion and its no-resume rule, resync keeping an open window, coalesced repairs, the replace fallback, the append-only and merge paths, and the subscribed-baseline repair. Builder tests cover partial-only publications and row reuse across structural rebuilds. ChatView tests cover the sampling cadence and the follow-write exemption. `serverRequestJson` tests cover memoization and rethrow.
