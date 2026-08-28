# @deepseek-ai/dsh-archive-gateway

English | [中文](README.zh.md)

Synchronizes the durable Workspace archive state of a Gateway-launched runtime with the Gateway archive index. The provider sends revision-stamped, idempotent batches containing archived IDs, root lineage, session headers, retained Workspace placement, message counts, and title/body search projections; Gateway commands are applied after every batch for that revision succeeds.

One synchronization request carries at most 1,000 session IDs, 5,000 search rows, and 4 MiB of search text. Search content is capped at 64 KiB per row for the index; the transcript remains unchanged. A root split across requests receives a final aggregate message count, repeated triggers while a synchronization is running collapse into one follow-up pass, and disposal aborts and joins the active request. A response carries at most 1,000 pending commands; applying a non-empty command page schedules another pass until the queue is empty.

Session title, message-count, and search projections use a 32 MiB LRU cache. A contiguous live `session/event` is appended to its cached projection in O(1) queue work; a sequence gap, title event, or read race invalidates only that session and falls back to a complete read. This keeps frequent archive updates from rereading unchanged logs while preserving revision consistency. Cache insertion is generation-fenced against an event arriving during the read, and invalidation tokens are removed with sessions and LRU evictions, so churn cannot leave a second unbounded roster behind the byte-bounded values.

The archive reader also keeps one in-process lineage/header index and rebuilds it only after a session topology change. Concurrent reads share the same index load; event and purge invalidations prevent a stale load from becoming the next cached index.

The provider also registers a loopback-only `/api/internal/archive/read` route. Gateway-issued archive capabilities can read a personal root and its descendants on demand; the route never accepts browser-origin traffic or a non-administrator assertion.

The provider is a runtime-only integration. Standalone local DSH compositions do not load it and keep their local archive registry unchanged.

## Model Experience

None, as the provider reads and synchronizes already-logged session state without adding prompts, tools, or model-request fields.

#### KV Cache effect

None. It does not assemble model requests or alter a reusable prefix.

## Known Limitations and Deferred Work

- Gateway synchronization is available only to runtimes launched with the Gateway credential; standalone local compositions keep their existing archive behavior.
- A personal transcript cannot be read while its owning runtime is unavailable or its persisted log is corrupt; the Gateway keeps the archive index row and reports the body as unavailable.
- Archive reads reject a lineage with more than 10,000 descendants or a post-floor result whose retained records exceed 100,000 records or 64 MiB. `fromSeq` is an inclusive sequence floor applied independently to every descendant session, not a global chronological cursor.
- A runtime-provided personal detail must fit the same descendant, event-page, and byte budgets; an invalid or oversized replacement leaves the indexed detail visible with `syncState: unavailable`.
