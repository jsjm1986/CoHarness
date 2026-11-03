# Agent Note: Project progress journal

Status: implemented

English | [中文](2026-10-21-project-progress-journal.zh.md)

## Problem

The [project activity feed](2026-10-17-project-activity-feed.md) records individual member messages and answers. Returning members also need a synthesized account of decisions, completed work and blockers. This artifact is human-facing; its generation and privacy rules belong to the Gateway's authoritative shared-conversation data.

## Decision

`PostgresProgressService` generates a rolling current entry and ISO-week period entries from shared-visible root conversations. The `visible` query requires organization/project ownership, non-deleted status and `visibility='project'`. Member messages and claimed question answers supply attributed material; a separately capped assistant stream supplies context. Event JSON navigation skips NUL-bearing payloads before decoding. Malformed historical answer elements contribute no text.

A sweep considers only projects whose fixed computer matches the Gateway. Candidate selection, public-id resolution and lease admission check that assignment; model dispatch checks it again after resource waiting. Organization ownership and a local Gateway process reservation do not authorize work for another computer's project. A sweep requires new material, enough member activity or a decision, sufficient quiet time, and spacing since the previous pass. A writer can request an asynchronous manual pass. Separate stream caps retain only a complete material prefix. Empty projects issue no inference.

Source eligibility uses exact consumption receipts keyed by Session and stable message/answer identity, rather than a timestamp watermark. Delayed older messages and newly claimed unanchored answers remain eligible. SQL and the application order complete prefixes by full microsecond time, UTF-8 Session bytes, sequence and stable entry bytes. Empty source rows also receive receipts, without issuing an empty inference. The displayed watermark only tracks the furthest processed position. Pending counts exclude consumed rows before decoding event JSON and omit unused title lookups.

### Request ownership and evidence

The [Gateway model owner](../architecture/2026-10-24-gateway-model-ownership.md) shares node admission with Runtime work, rechecks current permissions and routes after waiting, and joins HTTP cancellation before releasing occupation. Every provider attempt persists its exact request body before dispatch in `project_journal_requests`; credentials remain outside that journal. Response retention is byte-bounded. Prompt substitution preserves literal member text, including replacement metacharacters and template-like strings. Route identity uses the provider/model tuple. Fresh deployment headers accompany each request, Harness attribution wins reserved names, and output tokens respect both the digest cap and the served model limit.

Each pass subscribes to the existing durable access monitor through publication. Catch-up precedes capture, model dispatch and publication. Matching project/initiator changes cancel queued and active HTTP work; an organization invalidation or lost monitor connection cancels every local pass. Unrelated accounts leave the pass running. Cancellation prevents provider fallback and publication, including after HTTP completes. Notification acknowledgement initiates cancellation; resource accounting remains occupied until HTTP and billing cleanup settle. Shutdown stops all passes and removes its subscription.

The same insert persists an immutable `request_session` snapshot using the installed Session format, ordinary turn/step events, `request/header` and identified `user/message` events. Its producer source is `gateway-project-progress`, with no human participant. The snapshot supports the released logical catalog, and the canonical Session message/header readers reconstruct the actual wire input. It captures the open request immediately before dispatch; response, completion and usage remain in the sibling evidence fields. It is not registered as a member conversation and cannot become its own summary input. Migration 070 adds this artifact; older evidence rows retain their original request JSON. Migration 071 gives evidence the same permanent-project-deletion cascade as other project-owned progress data; archival retains it.

The same request UUID identifies a replayable project-infrastructure usage record. Successful responses split cached prompt tokens from uncached input; unavailable or invalid counts remain missing usage. Failed and cancelled attempts retain their status. A completed billing insert whose acknowledgement is lost replays without duplicate charging. An interrupted attempt becomes eligible for missing-usage delivery only after its physical resource ownership ends. Manual clicks retain queue attribution and request evidence without inventing a model-input participant. Project archival does not invalidate historical billing. Quotas remain advisory.

### Publication and source privacy

An atomic lease upsert assigns a unique generation. Dispatch renews only that generation; publishing locks visible source rows, then its generation row, then journal entries and consumption receipts. Entry upserts, receipts and the watermark commit in one transaction. A superseded pass cannot publish, clear a successor's lease, or overwrite its error. Failures keep material eligible and back off through `last_run_at`. Manual background work participates in maintenance quiescence; shutdown cancels and joins all passes before releasing their dependencies.

A shared root becoming private or deleted invalidates the project's synthesized entries and resets its receipts, watermark and generation in the source-change transaction. A root becoming shared also resets them so older newly visible material is included. Invalidated entries remain stored but are excluded from reads and subsequent prompts. This conservative rebuild is necessary because free-form summaries and carried-forward current/period text cannot be redacted reliably by individual reference. Migration 068 invalidates pre-existing entries once; migration 069 resets selection state to establish exact receipts. Regeneration uses the configured visible-material window. Source events and billing evidence remain retained.

### Product surface

`GET /account/api/progress` returns the current entry, periods and live status; `POST /account/api/progress/generate` requires project write authority. The `ui-project-activity` plugin renders progress by default, polls an active pass, and navigates attribution chips through the runtime-qualified Session viewport. Ordinary agent requests and the agent-memory catalog do not read this journal. Digest generation itself uses the eligible previous current/period text as context.

## Alternatives considered

- Runtime-side curation cannot authorize shared/private source visibility from its local log alone. Gateway SQL owns source selection and invalidation.
- Placing journal entries in agent memory would broaden their audience and execution participation. The human artifact stays in its own domain.
- Redacting only attributed items leaves unreferenced summary text and carried-forward context exposed. Invalidating and rebuilding the synthesized artifact preserves the source privacy rule.
- A timestamp-only lease cannot fence a delayed predecessor after recovery. Every publication and cleanup uses the unique generation.
- A timestamp selection cursor cannot distinguish PostgreSQL microseconds lost in JavaScript dates, answers sharing an anchor, or late arrivals. Exact source receipts preserve those inputs; a timestamp remains useful only for display.
- Synchronous fire-and-forget billing loses interrupted attempts or duplicate acknowledgements. Durable request evidence and UUID deduplication preserve them.
- A dedicated utility request Session preserves the normal model-input reconstruction rule without adding infrastructure prompts to the shared conversation index. The immutable pre-dispatch snapshot and sibling outcome fields have separate purposes.

## Consequences

The journal has dedicated entry, generation, source-receipt and request-evidence tables. It retains its account routes and client response fields. Model timeouts, response bytes, replay batch size, material caps and sweep gates are validated Gateway configuration. Deployment and initial rebuild instructions live in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/managed-resource-admission/guide.md).

## Verification

Two logical computers with real node budgets and kernel-backed Gateway owners verify local-only sweeps, exact request-node attribution, independent project billing and receipt replay. Foreign projects receive no lease or error state.

Unit tests cover gates, complete prefixes, output references, route tuples, literal prompt text and malformed historical answers. Real Gateway HTTP/PostgreSQL snapshots cover queued generation, current authorization and source changes. Regressions exercise stale predecessor publication, response cancellation, archived-project billing, billing acknowledgement replay, source-private/source-shared rebuilds, exact source ordering, late arrivals and atomic receipt rollback. HTTP checks observe the Session before dispatch; the released catalog and ordinary-Node canonical readers reconstruct the exact request. Database checks reject malformed Session identities and replacement of committed request snapshots. Web presentation retains its existing runnable progress and activity examples.

The [built read diagnostic](../../../../gateway/tests/progress-material.perf.ts) compares the production `progressForUser` path against commit `2896f75419ca38682a4a96151ee15beee009ccac` with three fresh processes per variant, ten warmups and three batches of ten reads, PostgreSQL pool size one, and one retained page. On macOS arm64, Node 25.8.1 and PostgreSQL 17.6, median milliseconds for 0/20/all pending sources are 6.21/6.77/6.82 before and 5.95/7.06/7.27 with receipts for four roots and 200 messages; for twenty roots and 20,000 messages they are 41.27/40.06/183.79 before and 53.96/53.74/143.40 with receipts. Median process RSS is about 67 MiB before and 70 MiB with receipts. HTTP, model lookup/inference, database-server memory and concurrent load are excluded. Exact receipt lookups add work to mostly consumed large histories; early exclusion avoids decoding their payloads. Reproduce from a built Gateway with a disposable `HGW_TEST_DATABASE_URL`, `HGW_PROGRESS_PERF_BASELINE_REF` set to that commit, and `HGW_PROGRESS_PERF_SCALE=ordinary` or `large` via `TSX_TSCONFIG_PATH=tsconfig.run.json node --import tsx/esm tests/progress-material.perf.ts`.
