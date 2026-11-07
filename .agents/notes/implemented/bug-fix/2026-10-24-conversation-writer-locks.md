# Agent Note: Conversation writer authority after lock waits

Status: implemented

English | [中文](2026-10-24-conversation-writer-locks.zh.md)

## Problem

A PostgreSQL query evaluated project membership and administrator authority before acquiring its account and project row locks. If a revoker held an unchanged account or project row while updating a related membership, the waiting writer could keep its earlier permission result and materialize a conversation after revocation. A row lock does not refresh unrelated permission rows in that statement's snapshot.

## Decision

`ConversationRepository.projectWriter` first locks the active account and project, then reads authority in a separate statement. A materialized account CTE orders the account lock before the project lock within the first statement. The second statement requires active organization membership plus project `rw` or administrator authority; steward projects additionally require administrator status and an enabled qualification. Creation and attributed append use this check, and `CollaborationDeniedError` maps denial to HTTP 403. An attributed append rolls back events, search rows and contribution rows together.

Interaction and visibility checks follow the [steward admission decision](../feature/2026-10-10-steward-admin-layered-admission.md). The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/conversation-writer-authorization/guide.md) covers persistence clients.

## Verification

Real Gateway HTTP regressions pause creation and append behind actual membership removal, role demotion and `rw`-to-`ro` changes. Six scenarios deny with 403 and retain no new events. A public-to-private transition also denies another member’s queued append with 403; the earlier generic error returned 500. Reintroducing the earlier combined permission/lock query returns 200 after removal or role demotion. The foreign-key fixture now provisions its organization membership before exercising unrelated reference checks.

## Performance

The diagnostic is `gateway/tests/conversation-writer.perf.ts`, run after the Gateway build with `HGW_TEST_DATABASE_URL` selecting a disposable database and `HGW_WRITER_PERF_BASELINE_REF=2896f75419ca38682a4a96151ee15beee009ccac`. It compiles that reference's repository source and exercises both actual built implementations in fresh plain-Node children.

| Measurement | Definition |
| --- | --- |
| Completion | One attributed message committed through `ConversationRepository.append` |
| Workload | Synthetic regular writer or implicit administrator; 64 or 4,096 prior events |
| Timing | One-connection pool; ten warmups; three batches of twenty appends; three fresh children per variant; alternating variant order |
| Memory | Last insertion result retained; process peak includes setup; one GC before steady RSS |
| Limits | Diagnostic only; no HTTP, inference, concurrent writers or database-server memory; no timing budget |

Median milliseconds per append, before → current: regular/64, 8.583 → 8.355; regular/4,096, 8.476 → 9.164; administrator/64, 8.201 → 9.053; administrator/4,096, 8.704 → 8.950. Process peak medians were 79.80 → 79.57 MiB. These shared-host samples establish the measured cost, not a general latency improvement. A three-statement account/project/authority path measured 9.545–9.828 ms; combining only the lock acquisition removes one round trip while preserving the later authority snapshot.

## Consequences

Waiting does not extend a writer's authority. Persistence clients receive the shared forbidden result and refresh scope access before retrying. The additional authority statement has a measured database cost; it preserves existing event formats and atomic batch outcomes.

## Alternatives considered

**Put permission predicates back into the lock query.** Rejected because waiting on an unchanged account or project row does not make the related membership predicate current. The functional negative controls fail even when that query holds both locks by the time it returns.
