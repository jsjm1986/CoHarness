# Agent Note: Cross-Gateway access invalidation

Status: implemented

English | [中文](2026-09-22-cross-gateway-access-invalidation.zh.md)

## Problem

A Gateway-local cancellation callback cannot close traffic admitted by another Gateway. A still-valid signed principal and a successful earlier Session read also cannot prove that an account, project membership, or conversation remains readable. PostgreSQL audit writes occur independently after business transactions and cannot establish atomic revocation delivery.

## Decision

The [Gateway](../../../../gateway/README.md) records access changes in the existing PostgreSQL outbox inside the transaction that changes the authoritative rows. One organization revision and one deduplicated subject list cover each transaction. The organization row lock orders revisions by commit availability; an independently allocated sequence could let readers skip an earlier uncommitted transaction. This serialization applies to access changes, not ordinary message writes or uploads.

`LISTEN`/`NOTIFY` wakes a bounded reader of the durable revisions. Notifications carry no authority and may be duplicated or missed. A disconnected listener cancels admitted traffic, while reconnect and request admission read committed records before proceeding. Local callbacks remain immediate. Directory changes additionally stop affected runtimes so a fresh process loads the current filesystem grants. An unavailable or incomplete revocation history blocks admission instead of relying on the assertion lifetime.

The [API proxy](../../../../packages/host/apiproxy/README.md) deduplicates pending reads without retaining positive authorization indefinitely. Mux and Host publication batches recheck Session visibility before delivery, including buffered baselines and aggregate references. Cancellation discards buffered frames. Session operations retain their current per-operation authorization and directory containment rules.

Gateway-owned selected-scope document responses share this monitor. Registration precedes authorization; it ends after response cleanup. Every matching listener starts cancellation before the monitor awaits runtime stops. Concurrent EOF and cancellation share one lease-release result, including failure, and a late response is cancelled even when its downstream already closed. Failed cleanup remains observable to subsequent synchronization, so a closed HTTP response alone cannot acknowledge the revision. Download cancellation leaves unrelated subjects, metadata, and ordinary upload registration unaffected.

## Alternatives considered

**Publish a best-effort notification after the service call.** A crash between the commit and notification loses the revocation. Transactional triggers cover all writers of the same access rows.

**Use only principal expiry or cached successful reads.** This preserves stale access until expiry and can keep a previously readable Session visible indefinitely inside a stream.

**Invalidate on every row write.** Session creation, append counters, login activity, and document registration do not revoke existing access. Cancelling them can interrupt the upload or creation request that made the write.

## Consequences

Each Gateway reserves one database listener connection. Access-changing transactions briefly serialize on the organization row; multiple affected rows produce one notification and one replay record. A cold process resumes its compute node's last successfully applied runtime revision. A running process retains its own cursor across reconnects, even when another process acknowledges newer revisions on that node. Each read coalesces its entire observed backlog by subject before stopping runtimes; cancellation and stop must settle before acknowledgment or reconnect admission. A cancellation failure keeps admission closed.

Outbox records remain retained; `completed_at` does not authorize deletion. An offline node must receive every unapplied revision, and automatic compaction requires a separate enrollment and retention policy. Polling covers a lost wakeup, and fresh admission reads also limit delay. This extends the existing PostgreSQL control plane without a separate broker or per-message audit stream.

Real PostgreSQL tests exercise two HTTP/WebSocket Gateways, commit and rollback, batched subjects, lost listeners, reconnect catch-up, affected-user isolation, and ordinary upload/Session writes. The upstream runtime in these tests is a transport fixture; actual directory isolation retains its provider tests. Controlled API stream tests cover already-readable Sessions and queued publication. Transport cancellation does not erase content already rendered or cached by a browser. Nor does it establish quiescence of that participant's existing model/tool tasks inside a shared project runtime: those tasks need participant-owned cancellation. These Client and shared-task behaviors require independent acceptance evidence.
