# Agent Note: Project deletion retains authority and stop ownership

Status: implemented

English | [中文](2026-10-28-project-deletion-lifecycle.zh.md)

## Problem

A rejected project deletion can still stop a shared Runtime. Publishing a stopped assignment before removing its catalog entry also permits another Gateway to start a replacement during deletion. Resource cleanup must distinguish confirmed process quiescence from completion of the surrounding storage operation.

## Decision

The [administrator route](../../../../gateway/src/admin-api.ts) refuses reserved Steward deletion before lifecycle effects. Standard project deletion passes its authenticated actor to both the initial stop transition and the catalog transaction. PostgreSQL retains current active account and organization-membership rows before the project lock, requires the administrator role and checks organization availability before committing the stop intent. The transaction releases its connection before process termination and accounting; a one-connection pool therefore remains usable. Approved stop intent cancels the target's queued start. Catalog removal rechecks current administrator authority after termination.

[`withStopped`](../../../../gateway/src/instances.ts) acquires a [durable operation](../../../../gateway/deploy/postgres/migrations/078_runtime_destructive_operations.sql) bound to the stable RuntimeId, node, process generation, unique operation ID and retained Gateway owner. Database enforcement blocks generation changes, ready publication, reassignment and replacement assignments for that owner until the operation settles, including after another coordinator publishes stopped. The environment directory retains the operation after live assignment deletion. Exact operation and Gateway identities authorize release; elapsed time provides no recovery evidence.

The initiating manager defers its stopped publication through data work. Confirmed termination releases process capacity. A never-started assignment does not require a recovery handle. Synchronous callback and publication failures preserve their separate causes. The [Gateway process witness](../architecture/2026-10-24-gateway-model-ownership.md) stays owned through the callback and cleanup without consuming model credits; close joins administrative callbacks before retiring that witness. Uncertain acquisition or failed release retains the operation until exact release or proved Gateway retirement. Surviving stopping assignments still require confirmed Runtime termination before restart.

The [node accountant](../../../../gateway/src/node-resource-budget.ts) first reclaims execution reservations while retaining an empty registration for the confirmed quiescent generation. This record prevents the still-stopping assignment from blocking unrelated work as an unregistered Runtime; its observed state refuses new execution. Stopped publication or catalog removal precedes final registration cleanup and fair wakeup, including failed starts and dead-process recovery. Older generations remain fenced independently.

Permission refusal before stop intent leaves the Runtime untouched. Revocation after an approved stop can refuse catalog removal while preserving the project and files with a stopped Runtime. Unconfirmed termination refuses data work and returns503 with a retained cause. Post-operation publication or accounting can fail after a committed catalog deletion; operators inspect current state before retrying. Imported and retained files follow the independent [project transaction decision](2026-10-23-project-creation-transactions.md). [Process admission](../architecture/2026-10-23-gateway-runtime-admission.md), [supervision](../architecture/2026-10-25-local-runtime-supervisor.md) and [shutdown worker draining](2026-09-17-stop-all-worker-failures.md) keep their separate ownership rules.

## Alternatives considered

**Hold the authorization transaction through process termination.** Stop supervision and accounting need database operations of their own; retaining the sole connection can prevent the operation from completing.

**Publish stopped immediately after termination.** Another coordinator can claim a replacement while the destructive storage operation is still pending.

**Remove resource registration together with reservations.** The node's unregistered-Runtime protection then suppresses queued work while the assignment remains stopping.

## Consequences

Permission, termination and committed data outcomes remain distinct. A failed deletion does not promise that an already authorized stop was undone. Custom PostgreSQL compositions inject process ownership before destructive dispatch. Real PostgreSQL/Gateway transcripts use an observable HTTP listener as a synthetic Runtime carrier; separate LocalLauncher regressions execute real child processes. Stale-statement and SIGKILL cases exercise database and kernel ownership. These checks do not establish native Windows behavior or live model-provider success.
