---
kind: upgrade-guide
description: "Explicit Runtime control retains current initiating administrator authority and reports database capacity with HTTP 503."
---

# Retain administrator authority through Runtime control

English | [中文](guide.zh.md)

## Change

Personal and project Runtime start, stop and restart retain the authenticated initiating administrator through lookup, lifecycle and admission waits. Revoked authority returns403. Different administrators do not share pending starts. Final personal admission checks current owner policy and administrator authority together.

An approved stop can finish before authority is revoked. Restart then returns403 and leaves the Runtime stopped. A refused request does not undo an already approved cancellation or stop. Exact administrator stop and restart of a reserved Steward Runtime require current administrator authority and the selected generation, without requiring Steward data qualification. Project deletion remains refused.

Bounded PostgreSQL checkout refusal returns503 with readable `error` and `code: DB_CHECKOUT_QUEUE_FULL`. Reload current state before deciding whether to retry, because a multi-stage operation may have completed an earlier stage.

Read-only terminal and plugin inventory reports `503 INSTANCE_UNAVAILABLE` when a recovered owner lookup, controller attachment or liveness probe is unavailable. The recorded Runtime generation and resident occupation remain retained; retry after ownership can be confirmed.

Terminal and plugin administration rechecks the current administrator before Runtime dispatch and response publication. Ordinary plugin replies are buffered within the configured byte limit until cleanup and authorization finish. Withdrawal before publication returns403; withdrawal after authorized streaming progress interrupts the stream before later chunks. An admitted mutation may already have completed, so reload its state before retrying.

PostgreSQL account reads report disabled eligibility while the organization is disabled, preserving stored account and membership states for later restoration. Re-enabling the organization does not re-enable an independently disabled account or membership.

## Migration

1. Deploy Gateway using the [existing procedure](../../../../gateway/README.md). This administrator-control change adds no schema or Session-format migration.
2. Custom instance services forward the supplied administrator id in `ensureRunning(subject, intent, administratorUserId)` and `stop(target, reason, administratorUserId)`, including both restart stages. Obtain the id from server authentication. Omission is reserved for trusted internal maintenance.
3. Custom repositories implement `authorizeAdministrator`, `markControlStopping`, and the administrator arguments to `beginStart` and `personalPolicy`. Retain current authority through each intent write or joint owner-policy read, then release database connections before resource or supervisor waits. Forward the optional `withStopped` purpose to `acquireStopLease`: `control` requires current administrator authority; omitted or `destructive` purpose retains project-data protection. Keep exact generation, node, Gateway process ownership and stop-operation checks for both purposes.
4. Verify that revocation during target lookup, queueing, policy preparation and pressure waiting prevents later effects; revocation after an approved restart stop leaves the Runtime stopped; a current administrator can control both owner kinds. See the [control decision](../../../../.agents/notes/implemented/bug-fix/2026-10-29-administrator-runtime-control.md).
