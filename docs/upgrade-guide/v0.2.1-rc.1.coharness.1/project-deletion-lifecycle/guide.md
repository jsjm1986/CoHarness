---
kind: upgrade-guide
description: "Project deletion checks current authority before stopping and keeps replacement starts blocked until storage work settles."
---

# Preserve project deletion permissions and stop ownership

English | [中文](guide.zh.md)

## Change

Administrator project deletion requires current active organization administrator authority before committing stop intent and again before removing catalog data. Revoked requests return403. Reserved Steward deletion returns409 without stopping its Runtime. A revocation after approved stop intent can refuse catalog removal while leaving the preserved project stopped.

Migration 078 retains a Gateway-owned destructive operation by stable RuntimeId. Replacement starts and reassignment remain blocked until the operation settles, even if another coordinator publishes stopped or removes the live assignment. Gateway shutdown joins the operation before retiring its kernel witness. Missing acknowledgements retain protection until exact release or proved owner retirement.

Confirmed quiescence reclaims reservations while retaining an empty registration until stopped publication or catalog removal. This also applies to failed starts and dead-process recovery. A failed stop returns503 `runtime-stop-failed`, with no catalog deletion. Publication, accounting or operation-release errors can follow a committed deletion, so inspect current state before retrying.

## Migration

1. Follow the existing [Gateway deployment procedure](../../../../gateway/README.md), apply PostgreSQL migration 078 after 076–077, and replace older Gateway writers together. No Session format or request-body migration is required. Preserve the node-local Gateway lock directory used by existing process ownership.
2. Custom project-removal routes pass the server-authenticated actor to `InstanceManager.withStopped` as its third argument and to `GatewayProjectService.remove` as its second argument. Request fields cannot supply this identity.
3. Custom PostgreSQL `InstanceManager` compositions pass `GatewayModelBudget` as the sixth constructor argument. Its `withOwnership` retains administrative callbacks without model credits. Distributed repositories implement `acquireStopLease` and `releaseStopLease`; acquisition retains current administrator authority and the deletable assignment in one transaction. Local test adapters retain the optional actor argument on `markStopping`. Omission remains trusted lifecycle maintenance.
4. Accounting adapters honor the `stopped` registration phase. Retain releases reservations but keeps an empty, non-executable registration; remove clears it after assignment publication or removal.
5. Verify revoked deletion preserves project data and a warm Runtime, Steward deletion returns409, and normal deletion preserves host files while removing the catalog entry. Read the [failure and ownership decision](../../../../.agents/notes/implemented/bug-fix/2026-10-28-project-deletion-lifecycle.md) before automating retries.
