# Agent Note: Project activity feed — a human-facing record of member input

Status: implemented

English | [中文](2026-10-17-project-activity-feed.zh.md)

## Problem

A shared project runtime hosts many conversations used by several members. Today a member who returns to the project can only learn what teammates did by reading whole transcripts or by asking the agent. User input is already recorded with participant attribution, but there is no human-facing view that answers "who said what, and which option did they choose". This note designs that view as a right-sidebar panel, without introducing model-facing memory.

## Decision

Add a **project activity feed**: a `ui-project-activity` client plugin that lists member-authored messages and question answers for the connected project, grouped three ways (time / conversation / member), with jump-to-message navigation. The panel later gained a fourth, default `progress` mode rendering the [human-facing progress journal](2026-10-21-project-progress-journal.md); the three feed groupings remain its raw views.

### Recorded content

- **Messages**: `user/message` events whose `source.kind === 'user'` and whose `source.participant` carries attribution. This matches the human-authored filter `conversation_search` already applies; system-injected text (goal summaries, participant notices, scheduled or webhook prompts with different `source.kind`) does not appear.
- **Question answers**: rows of `conversation_interaction_responses` with `interaction_kind='question'` — the responder and the selected answer are already durable in `responder_user_id` and `outcome`. The answer row links back to its question through the tool `callId`.

Approvals, permission-mode switches, automation runs, unread markers, and notifications are out of scope. Private conversations appear only to their creator or an organization administrator; the feed applies the same visibility SQL as `listConversations`.

### Derivation: query-time, not a derived table

Every field already exists in durable storage, so the feed is one paginated read, not a new write path:

- Messages come from `conversation_events` (`event_type='user/message'`), which stores the full event JSON including `source.participant`.
- Answers join `conversation_interaction_responses` to `conversation_events` on `call_id` → `event->'data'->>'callId'`, which the existing partial index covers. The question text comes from the matching `tool/call` event's arguments; the seq anchor from the `tool/result` row.

The one durable gap is the `callId` on the claim row: `question/requested` carries `wait.callId` on the wire but is not a logged session event, so the rpcId↔callId link is lost at claim time. Migration 056 adds `call_id text NULL` to `conversation_interaction_responses`; `execution.answer` / `claimInteraction` gain an optional `callId` the api-proxy fills from `pending.wait.callId`. Claims written before the migration keep `call_id NULL` and render as "question not located" — responder and answer still show; there is no jump and no question text.

### Server surface

`GET /account/api/activity?before=<keyset>&limit=<n>` on the Gateway, beside `/account/api/conversations`. The handler requires the caller's resolved account scope to be a project, applies the `listConversations` visibility clause to the owning root conversation, and returns a normalized `ProjectActivityItem` list. Browsers call it with the session cookie like every other collaboration read.

Cursors are opaque, versioned values containing the full PostgreSQL microsecond timestamp, Session id, log anchor, and individual entry id. Resume comparisons match timestamp descending, Session id ascending, anchor descending, and entry id ascending. The final id distinguishes historical answers that share an absent log anchor. Session ids containing delimiters remain intact. Legacy millisecond cursors remain readable; malformed cursors read the first page. Non-object elements in historical answer arrays contribute no summary text; the original outcome remains available in the response.

### Client surface

- `packages/client/ui-project-activity` registers a `sidebarRightTabs` type and keyed body/title slots. Registration follows the selected Session’s project Runtime, so opening a project Session from a personal bootstrap page still offers activity. Unqualified standalone Sessions use the page policy. A body captures its Session owner for its lifetime and addresses feed, journal and generation requests with `dshRuntime` and `dshTarget`; another tab’s scope cookie cannot redirect them. The Gateway remains the current access authority. Journal polling has one finite window; a still-generating response does not restart its round budget. A superseded read cannot publish after a newer refresh, including after JSON decoding.
- Requests authenticate through same-origin account cookies; explicit Runtime parameters grant no access. The [Runtime-qualified Session decision](../architecture/2026-09-27-runtime-qualified-client-sessions.md) owns shared browser addressing and account-lifetime isolation.
- Conversation names call `conversationViewport.replaceActive`; anchored rows call `ConversationViewport.reveal(sessionId, seq)`. The owning Chat view loads history through `loadHistoryUntil` and scrolls to that event. Feed Session IDs are Host-local, so `sessions.keyFor` receives the body’s captured Runtime, including its UUID. Project-only keys do not identify an allocation when the browser pools several Runtime connections.

### Presentation (reviewed HTML mock)

Each grouping mode is a folded reading view: `time` folds rows into one collapsible section per day (today open by default) whose entries are single-line summaries that expand an inline detail card — question text, full content, and a jump-to-conversation action; `conversation` renders one folded block per conversation whose header carries a colour dot, title, and recency, whose digest line prefers the newest answer ("chose: question → answer (actor)"), and whose meta row shows actor avatars, entry count, and decision count; `member` renders one folded block per member (avatar, name, counts) with digest lines listing choices before messages. The conversation colour dot hashes `sessionId` into a fixed five-tone palette. Answer rows carry the accent "chose" verb; messages stay plain text; row clicks still `reveal(sessionId, seq)` and the conversation chip `reveal(sessionId, null)`. Fold state is component-local. Toolbar, member filter, refresh, and pagination are unchanged; all styling uses `ui-theme` tokens.

Group keys use stable Session or member IDs. Concatenating names with IDs permits collisions and splits renamed identities; newest-first rows supply display metadata.

Calendar labels follow the viewer's local dates. A daylight-saving transition can make one calendar day last 23 or 25 hours, so an elapsed 24-hour offset cannot identify yesterday.

## Alternatives considered

- **Derived `project_activity` table written in `append()`**: unnecessary — `conversation_events` already holds attributed message JSON and the claim join covers answers. A second write path would only duplicate data and add backfill work.
- **Memory / model-facing recall**: rejected for this feature. Feeding extracted summaries to the model raises attribution-through-compaction, private-conversation leakage, and execution-participation questions the repository has not settled. The feed stays outside the model path entirely. The human-facing digest the same problem suggested later shipped separately as the [project progress journal](2026-10-21-project-progress-journal.md).
- **Approvals in the feed**: removed at design review; the feed's job is quick comprehension of what members typed and chose, and approval noise works against that.
- **Automation rows (schedule/webhook runs)**: deferred to a separate automation-health view; `conversation_search`'s `source.kind === 'user'` filter already excludes them from this feed.
- **Millisecond timestamp and log anchor alone as a cursor**: PostgreSQL answer times retain microseconds, and historical claims can share an absent anchor. Truncating time or omitting the individual entry id loses rows between pages.

## Consequences

- One additive migration (`call_id`), one optional parameter on two claim surfaces, one new Gateway GET route, one new client plugin package, one new viewport method. No session-format change, no model-visible change, no business-logic change to chat.
- Historical question answers display responder + selected answer without a question link until claims start carrying `call_id`.
- The reveal mechanism benefits any future deep-link feature.

## Testing

- `packages/client/ui-project-activity/tests/apply.client.spec.ts` covers scope-gated tab registration/disposal, grouping, member filtering, pagination, and reveal's `sessions.keyFor` translation.
- `apps/web/tests/project-activity.e2e.ts` boots the real web composition over a mocked Gateway, seeds a conversation, changes the shared scope cookie from a second tab, refreshes the original project's feed, pins its UI snapshot, and clicks a row to land on the logged event.
- Real Gateway HTTP/PostgreSQL snapshots cover timestamp ties, microsecond intervals, unanchored answers, delimiter-bearing Session ids, legacy and malformed cursors, mixed messages and answers, and invalid historical answer elements.
- Browser regressions cover 23-hour and 25-hour local days in `America/New_York` through the Time and Conversation views.

The built pagination diagnostic uses four roots, 100 messages, 100 answers and 50-row pages on Node 25.8.1/macOS arm64 with PostgreSQL 17.6 over loopback, one pool connection, three fresh processes per variant and three 30-call batches after ten warmups. Median first-page time is 10.715 → 11.166 ms, peak RSS 69,664 → 69,712 KiB and post-GC RSS 69,584 → 69,616 KiB. Next-page time is 9.241 → 9.606 ms, peak RSS 69,392 → 69,744 KiB and post-GC RSS 69,408 → 69,664 KiB. The measurement excludes HTTP, database-server memory and concurrency. Reproduce from Gateway with `HGW_ACTIVITY_PERF_BASELINE_REF=2896f75419ca38682a4a96151ee15beee009ccac TSX_TSCONFIG_PATH=tsconfig.run.json node --import tsx/esm tests/project-activity.perf.ts` after building and selecting a disposable `HGW_TEST_DATABASE_URL`; the script compiles that original source and measures both emitted implementations under plain Node.
