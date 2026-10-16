# Agent Note: Project activity feed — a human-facing record of member input

Status: implemented

English | [中文](2026-10-17-project-activity-feed.zh.md)

## Problem

A shared project runtime hosts many conversations used by several members. Today a member who returns to the project can only learn what teammates did by reading whole transcripts or by asking the agent. User input is already recorded with participant attribution, but there is no human-facing view that answers "who said what, and which option did they choose". This note designs that view as a right-sidebar panel, without introducing model-facing memory.

## Decision

Add a **project activity feed**: a `ui-project-activity` client plugin that lists member-authored messages and question answers for the connected project, grouped three ways (time / conversation / member), with jump-to-message navigation.

### Recorded content

- **Messages**: `user/message` events whose `source.kind === 'user'` and whose `source.participant` carries attribution. This matches the human-authored filter `conversation_search` already applies; system-injected text (goal summaries, participant notices, scheduled or webhook prompts with different `source.kind`) does not appear.
- **Question answers**: rows of `conversation_interaction_responses` with `interaction_kind='question'` — the responder and the selected answer are already durable in `responder_user_id` and `outcome`. The answer row links back to its question through the tool `callId`.

Approvals, permission-mode switches, automation runs, unread markers, and notifications are out of scope. Private conversations never appear; the feed applies the same visibility SQL as `listConversations`.

### Derivation: query-time, not a derived table

Every field already exists in durable storage, so the feed is one paginated read, not a new write path:

- Messages come from `conversation_events` (`event_type='user/message'`), which stores the full event JSON including `source.participant`.
- Answers join `conversation_interaction_responses` to `conversation_events` on `call_id` → `event->'data'->>'callId'`, which the existing partial index covers. The question text comes from the matching `tool/call` event's arguments; the seq anchor from the `tool/result` row.

The one durable gap is the `callId` on the claim row: `question/requested` carries `wait.callId` on the wire but is not a logged session event, so the rpcId↔callId link is lost at claim time. Migration 056 adds `call_id text NULL` to `conversation_interaction_responses`; `execution.answer` / `claimInteraction` gain an optional `callId` the api-proxy fills from `pending.wait.callId`. Claims written before the migration keep `call_id NULL` and render as "question not located" — responder and answer still show; there is no jump and no question text.

### Server surface

`GET /account/api/activity?before=<keyset>&limit=<n>` on the Gateway, beside `/account/api/conversations`. The handler requires the caller's resolved account scope to be a project, applies the `listConversations` visibility clause to the owning root conversation, and returns a normalized `ProjectActivityItem` list. Browsers call it with the session cookie like every other collaboration read.

### Client surface

- `packages/client/ui-project-activity` registers a `sidebarRightTabs` tab type plus `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` slots, mirroring `ui-sidebar-terminal`. The web-app composition keeps the row enabled; the apply body subscribes to `projectUiPolicy` and mounts or disposes the tab definition on each scope transition, so the guide entry and any open tab appear only in project scope — there is no static per-space patch.
- The panel fetches via a package-private `fetch` client (`credentials: 'same-origin'`); the route resolves the project from the caller's active account scope, so no project id travels on the wire.
- Jumping uses two behaviors: a conversation name focuses or opens the pane (`conversationViewport.replaceActive`); an entry calls the new `ConversationViewport.reveal(sessionId, seq)` — the viewport focuses the pane and publishes a reveal request; the owning `ChatView` subscribes through the inject `hooks` face, locates the turn containing `seq`, loads history through the existing `loadHistoryUntil`, and scrolls to the row. Feed rows carry wire session ids; the plugin translates them to the runtime-scoped client identity through `sessions.keyFor` before calling either method. This is the only new cross-plugin capability.

### Presentation (reviewed HTML mock)

L1 hairline list: day → conversation → entry rows separated by 0.5px `border-l1` rules; a segmented `time | conversation | member` grouping switcher, a member filter, and manual refresh in the toolbar; answers render the question text dimmed plus the selected answer as an accent-tinted `radius-full` capsule. All styling uses `ui-theme` tokens.

## Alternatives considered

- **Derived `project_activity` table written in `append()`**: unnecessary — `conversation_events` already holds attributed message JSON and the claim join covers answers. A second write path would only duplicate data and add backfill work.
- **Memory / model-facing recall**: rejected for this feature. Feeding extracted summaries to the model raises attribution-through-compaction, private-conversation leakage, and execution-participation questions the repository has not settled. The feed stays outside the model path entirely.
- **Approvals in the feed**: removed at design review; the feed's job is quick comprehension of what members typed and chose, and approval noise works against that.
- **Automation rows (schedule/webhook runs)**: deferred to a separate automation-health view; `conversation_search`'s `source.kind === 'user'` filter already excludes them from this feed.

## Consequences

- One additive migration (`call_id`), one optional parameter on two claim surfaces, one new Gateway GET route, one new client plugin package, one new viewport method. No session-format change, no model-visible change, no business-logic change to chat.
- Historical question answers display responder + selected answer without a question link until claims start carrying `call_id`.
- The reveal mechanism benefits any future deep-link feature.

## Testing

- `packages/client/ui-project-activity/tests/apply.client.spec.ts` covers scope-gated tab registration/disposal, grouping, member filtering, pagination, and reveal's `sessions.keyFor` translation.
- `apps/web/tests/project-activity.e2e.ts` boots the real web composition over a mocked Gateway, seeds a conversation, renders the feed (message, question, chosen answer), and clicks a row to land on the logged event.
- `listActivity` SQL semantics (visibility clause, answer join, keyset order) run in the Gateway Postgres lane on CI.
