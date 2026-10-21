# Agent Note: Project progress journal — a human-facing AI digest of shared activity

Status: implemented

English | [中文](2026-10-21-project-progress-journal.zh.md)

## Problem

The [project activity feed](2026-10-17-project-activity-feed.md) answers "who said what, and which option did they choose" row by row, but a member returning after a busy stretch still reads raw history to learn what the project decided, finished, and is blocked on. The request was a human-readable digest — "so members can pick up recent change without reading chat records" — with two firm boundaries: it must not run while nothing happened (no periodic empty passes), and it is a *human-facing journal, not agent memory* — the harness memory system is mature and separate; the journal may read member-visible material, but agents never consume the journal and the journal never enters the memory domain.

## Decision

Add a **project progress journal**: an event-gated AI digest pass in the Gateway's Postgres lane that folds shared-visible member activity into durable journal entries, plus a `progress` mode — the first and default segment — in the `ui-project-activity` panel.

### Storage: migration 059

- `harness.project_journal`: entries. `kind='current'` is the rolling "where the project stands" row (partial unique index, one per project, upserted every pass); `kind='period'` rows carry an ISO-week `period_key` (`YYYY-Www`), a structured `content` payload (`summary` plus `decided`/`done`/`doing`/`blocked` sections whose items attribute `{ text, actor?, sessionId, sessionTitle, seq? }`), `activity_count`, the source period bounds, and the resolved `model` route.
- `harness.project_journal_state`: per-project pass state — the committed watermark (`watermark_ts`, `watermark_session`, `watermark_seq`, ordered like the feed keyset), `last_run_at`, `generating_since` (the in-flight lease), and `last_error`.

### Material: member-visible only

A pass reads from a `visible` CTE that requires organization/project ownership, root conversations, non-deleted status, and `visibility='project'` — the same ownership boundary `listConversations` enforces. Member- or private-visibility conversations can never enter a project-wide journal. Within that boundary it collects member-authored `user/message` rows (the feed's `source.kind='user'` fold) and `question` interaction responses with an answer array — a selected answer is a decision — then folds rows into numbered material lines (`[n] timestamp · actor · conversation · said/decided: text`) for the prompt. Conversation titles come from `harness.human_session_title` with a first-human-row fallback. Row counts are bounded (`maxMaterialRows`, `maxAssistantRows`, `maxItemsPerSection`) and material is scoped to `materialWindowDays`. Real event payloads can carry a `\u0000` JSON escape (pasted binary content, tool-change scopes); Postgres `json` navigation de-escapes it and aborts the query, so every `event->`/`event->>` access routes through a `SAFE_EVENT` CASE guard that skips those rows at text level before any JSON navigation.

### Trigger: three gates, never a timer pass

The service sweeps candidate projects on a short unref'd interval (`sweepMs`) but a pass only starts when all gates pass:

1. **Activity gate** — at least `minActivity` new watermark rows; a single new decision (`hasDecision`) lowers the threshold.
2. **Quiet gate** — the newest activity is at least `idleMs` old, so a pass fires after a work burst settles rather than mid-stream.
3. **Interval gate** — at least `intervalMs` since the last committed pass.

Weeks of silence produce no candidate events and therefore no model calls. `POST /account/api/progress/generate` bypasses the gates for a member-forced pass. The watermark persists in Postgres, so a restart resumes where the last pass committed.

### Pass: single-flight, committed only on success

`acquire()` takes the `generating_since` lease as one atomic conditional upsert (`ON CONFLICT … DO UPDATE … WHERE` the lease is free or stale), so concurrent sweeps and manual passes cannot double-start; a stale lease past `leaseMs` is reclaimed, so a crashed run cannot wedge the project. The pass resolves the default route from the model-governance policy (`policyForProject`) and the organization's managed credential, then calls the chat-completions endpoint with a numbered-references prompt. Model output is validated: every decided/done/doing item must carry a `ref` resolving to a real material row (attribution copied from the row, never model-invented), `blocked` items may stand alone, unresolved refs drop the item, and output with neither a usable summary nor a valid item rejects the pass. On success one transaction writes the `current` upsert, the `period` upsert, and the watermark commit; a failed pass records `last_error` and leaves the watermark so the same rows re-enter the next pass. A no-material pass releases the lease without fabricating an entry. Manual generation is asynchronous — the HTTP handler returns `{ started }` and the pass runs in the background — so the request cannot outlive its timeout on a slow model.

### Client: `progress` as the default mode

`ui-project-activity` gains `fetchProgress` / `generateProgress` wire functions, `ActivityMode = 'progress' | ActivityGrouping`, and a `ProgressView` rendering the rolling current summary, folded period entries (newest open by default), section headers, attribution chips that `reveal` the source conversation, a generated-by/disclaimer line, and a status bar reporting `pending` undigested rows plus a "digest now" action. The store's default `grouping` is `'progress'`. While a page reports `generating`, the inject face polls the journal until it clears — including a pass already in flight when the panel opens. A `400`/`404` on the route renders as a feature-off page instead of a transport failure, so deployments without the service degrade quietly.

## Alternatives considered

- **Runtime-side curation pass writing memory entries** (the first design sketch): rejected. The authoritative shared-vs-private boundary is Gateway SQL (`conversation_*` visibility); a runtime fold cannot see `visibility='project'` and would risk leaking private conversations into a project-wide artifact. The gateway also already owns the model route and managed credential path.
- **Journal entries inside the agent-memory domain**: rejected per the feature request. Human journal and agent memory stay separate domains — the memory catalog never lists journal entries, and no model request reads them. Cross-reading the other direction (digest consulting memory facts) remains open but unimplemented.
- **Digest file or session in the workspace**: rejected — files fragment across periods and sessions bury the artifact in the chat list; a dedicated store keeps the "current + periods" shape the panel renders.
- **Timer-driven passes**: rejected — a fixed schedule burns tokens through quiet weeks; the event-gated sweep produces zero calls when nothing happens.

## Consequences

- One additive Postgres migration, two account routes, one `progress` config block (`HGW_PROGRESS*`), one unref'd sweep interval, one client mode. No session-format, model-request, or runtime change; the memory domain is untouched.
- Token cost is bounded by `intervalMs` and the material caps; `enabled: false` produces zero calls. Non-Postgres deployments mount no service and show the unavailable page.
- The feed's earlier [rejection of model-facing recall](2026-10-17-project-activity-feed.md) stands: journal entries never reach a model request. This note is the human-facing sibling that rejection anticipated.

## Testing

- `gateway/tests/progress-service.spec.ts` (16 cases): ISO week keys, output-reference validation including the blocked-standalone exception, unavailable route, free/stale/already-taken leases, the activity/decision/quiet/interval gates, successful insert plus watermark commit, `last_error` without watermark movement, decision folding from question plus answer, and shared-visibility material selection.
- `packages/client/ui-project-activity` unit specs (14) cover grouping and registration unchanged; `apps/web/tests/project-activity.e2e.ts` gained the progress-route mock and asserts the progress-first default before switching to the feed.
- `apps/web/tests/project-progress.e2e.ts` boots the real Web composition over a mocked Gateway: journal landing, period folding, attribution-chip reveal, the forced-pass poll from busy to landed, and the unavailable state without a generate affordance.
