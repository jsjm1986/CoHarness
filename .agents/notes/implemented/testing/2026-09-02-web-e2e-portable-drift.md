# Agent Note: Web e2e scenarios track the shipped Chat instead of the upstream recording

Status: implemented

English | [中文](2026-09-02-web-e2e-portable-drift.zh.md)

## Problem

The `web browser snapshot` gate ran for the first time on a GitHub-hosted runner once [portable runner defaults](../process/2026-09-02-portable-ci-runner-defaults.md) replaced the never-provisioned enterprise pool, and 26 of its 90 files failed. A local replay run on a 10-core machine failed the same 26 files, so runner speed was not the cause: the scenarios and goldens still described the upstream Chat that the alpha.1 alignment imported them from, while the shipped Chat had moved on. Three root causes explained most of the spread, one file exposed a Host defect that is fixed separately, and re-running the fixed lane on the current base surfaced one Chat defect that is fixed here.

- **Seeded histories had no time.** The alignment took upstream's projected fixtures (no `seq`/`time` fields, chunk runs packed into one row) but not the `seedSession` step that materializes event times from event order. Every seeded event sat at epoch zero, so dates rendered as `1970-1-1` and `StatsLine` derived zero durations, hiding the `LLM`/`Tool call`/`tok/s` segments that 33 goldens expect.
- **Settled turns fold their process.** `TurnProcessNodeView` now keeps a finished turn's tool calls and intermediate messages behind one `[data-turn-process]` disclosure, open only while the turn is streaming. Scenarios that located a historical tool row (`[data-sample="bash"]`, `[data-tool="skill"]`, `[data-workflow-run]`) timed out on rows that were mounted but folded.
- **Reading near the head loads older history by itself.** `ChatView.maybeAutoLoadOlder` requests the next page once the reader is within 240px of the head (one request per head), keeping the `Load earlier` control for a reader who stops short. Scenarios that wheeled to the top and then waited for the control found the page already loaded, the control gone, and the reader re-anchored below the top.
- **Opening a large cold session failed.** `historySourceFor` walks persistence pages for a detached session and rejects a revision change between pages. The browser open also attaches the session (`ensureSession` → `agents.resume`), which appends the resume lifecycle events and moves the JSONL revision under the walk. A history large enough to need several pages therefore opened to `history storage is temporarily unavailable` while a one-page history never hit the race. The Host fix is its own change ([history read survives concurrent resume](../bug-fix/2026-09-03-history-read-survives-concurrent-resume.md)); this note covers the scenario side that depended on it.
- **A tab or session switch inside the sampling interval lost the newest reading position.** `ChatView` samples reader geometry at most once per 500 ms with one trailing sample ([bounded live window](../bug-fix/2026-09-03-bounded-live-window-and-incremental-reconnect.md)); its unmount cleanup cleared the pending trailing timer without running it, so a switch within 500 ms of the last scroll saved nothing and the return restored the position before that scroll. `chat-scroll-contract` saw the anchor land 794px away from where it left.
- **The queue scenarios captured the composer mid-submit.** The queue dock lists a queued row as soon as the session stream carries it, while the composer keeps the draft and its disabled controls until the submit round-trip settles. Waiting for the `2 queued messages` header alone captured `Message the agent: Layout queue second` and a disabled `Send message` whenever the round-trip was slow.

The remainder was product surface that had legitimately changed: localized permission labels (`Read Only` → `仅可查看`, `Workspace Write` → `工作区内修改`), the sidebar's `New session in workspace` action and the removal of the `Ungrouped` bucket, hero and header layout, `session.list` returning `items` without draft sessions, a new default model (`deepseek-v4-flash-vision-exp`) and relabelled capacity fields, the web-surface system prompt text, and a `records`-based history wire format.

## Decision

Fix each cause once, at the layer that owns it, and re-record only the goldens whose diff is the intended product change.

- `seedSession` materializes event times the way upstream's does: `timeAnchor + index`, anchored on the fixture header's `createdAt` or the seeded creation time when normalization zeroed it. `rewriteSeedEvents(text, edit)` lets the two scenarios that trimmed or extended a recording edit decoded events instead of raw lines, which projected fixtures no longer support.
- `expandTurnProcesses(page)` / `collapseTurnProcesses(page)` open and refold every turn-process disclosure with plain Playwright waits, so they also run from `beforeAll`. Scenarios disclose before asserting on a historical row; scenarios whose golden captures the default view refold before capturing. The live-tool scroll scenario opens only its own turn's disclosure, because opening every loaded turn re-lays the whole transcript away from the tail it is measuring.
- Paging helpers accept either arrival path: `loadEarlierWithAnchor` wheels toward the head in short steps and stops at the first prepend, clicking `Load earlier` only when the head is reached without a request, and returns `false` once the whole log is loaded; `scrollToHistoryStart` no longer asserts a settled offset because the anchored prepend legitimately moves it.
- Seeded scenarios that assert on projections (`hasProjections`, the `(1)` fork-title suffix) call `sessionProjectionCache.coldSnapshot(id)` once after seeding. Every host-written session carries a projection-cache row; a seeded log has none, and `session.list` serves cold rows from that cache alone.
- Shared normalization gained `\b\d[\d,]*(?:\.\d+)? ms\b` → `{{duration}}` (wall time in trajectory tooltips) and the optional calendar-day prefix collapse `(?:\d{1,2}/\d{1,2} )?{{clock}}` → `{{date}} {{clock}}`, so goldens depend on neither the runner timezone nor the seed wall clock.
- The Trajectory bottom-follow budget is relative to what the turn appended (`scrollTo` calls ≤ appended rows / 4, with at least 20 rows appended) instead of the upstream constant 5: one streamed turn appends 85 chunks and the turn's lifecycle events here, and the invariant is "never per chunk", not a row count.
- `ChatView` runs its unmount cleanup in `useLayoutEffect` and executes a pending trailing sample there: layout cleanup runs before React detaches the child ref and removes the node, so the scrollport is still laid out, which the passive cleanup cannot guarantee.
- Queue scenarios wait for the composer draft to clear before capturing, as `live-interactions` already did; the golden describes the settled composer with the steer hint, which is the state a reader sees.
- Thirteen goldens were re-recorded after reviewing each diff against the product changes listed above; no golden lost transcript content.

## Alternatives considered

**Keep the fixed `Load earlier` paging model by disabling auto-load in tests.** Rejected because the auto-load is what a reader gets; a scenario that pins the manual control would pass while the shipped path is untested.

**Skip the folded-row scenarios or assert on the fold summary only.** Rejected because the rows behind the disclosure still carry the contract (identity, disclosure state across a scroll cycle, focus ownership); disclosing first keeps that contract under test.

**Re-record all 26 goldens without triage.** Rejected because 23 of the 26 files failed on behavior or timing, not on golden text; re-recording would have baked epoch dates and hidden statistics into the baseline.

## Consequences

The lane is green on the portable runner without changing its worker count or concurrency. Two behaviors surfaced by the seeded fixtures remain as product signals rather than test changes: a never-cached cold session that is opened and attached does not converge its list-row title until a projection changes or the client reconnects (the Host pushes `session/projection` frames only on change, and the client re-lists only on connection), and seeded or reloaded histories show no `TTFT`/`tok/s` because `assistant/chunk` events do not enter the conversation tier. Both are documented in the affected scenarios and left for a product decision.
