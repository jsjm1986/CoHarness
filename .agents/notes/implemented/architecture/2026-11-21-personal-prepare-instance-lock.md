# Agent Note: Share the instance lock for prepared personal conversations

Status: implemented

English | [中文](2026-11-21-personal-prepare-instance-lock.zh.md)

## Problem

Workspace directory publication holds a shared instance row lock to keep its generation and placement valid through commit. A prepared history or creation request can wait for that transaction when it acquires an exclusive lock to update the Runtime's start activity. On a remote node, the lock can be held between statements while the publisher waits for PostgreSQL responses over the network.

## Decision

For an exact prepared personal conversation on an already supervised Runtime, [browser admission](../../../../gateway/src/runtime-asset-admission.ts) verifies the request, takes a shared lock on the selected ready instance and reads fresh authority after that lock. The browser session, computer grant, forwarding issuer, serving epoch and Runtime generation qualify in one database round trip. The owner Gateway checks its revocation monitor before dispatch and the Host applies the existing Session authority.

The [instance manager](../../../../gateway/src/instances.ts) retains the exact generation before qualification and keeps it until the completion activity write settles. The write is monotone and generation-bound. Prepared project requests, event upgrades and prompt admission use the existing start and completion activity writes.

The owning Gateway also uses this admission for [qualified browser reads](../../../../gateway/README.md#performance-and-runtime-admission). Boot, catalog and history reads retain the original Host methods. For example, an exclusive history cursor keeps its original page size and can read an archived Session according to the same Host permission. Qualifying a ready personal Runtime checks the permission revision after the shared lock. If the generation is unavailable, normal routing still controls startup and manual stop.

## Alternatives considered

**Use a plain authorization read.** A shared lock waits for a concurrent instance writer and the second authorization snapshot observes committed changes after that wait. A plain read could authorize from the old instance row during a generation change.

**Move catalog publication outside its transaction.** The directory writer must protect placement and generation through publication. Removing that lock would require a different placement protocol across the governance and node stores.

**Send history continuation through the explicit prepare route.** It can start a stopped Runtime and rejects archived Sessions. Sharing its ready-generation admission in the Gateway gives existing browsers the shorter read path and retains their read semantics.

## Consequences

Prepared personal admission can proceed alongside a directory writer's shared instance lock. It can still wait for an instance change or other exclusive writer. The admission read does not advance the durable activity timestamp. Completion advances it before the Runtime reference is released.

The [PostgreSQL admission tests](../../../../gateway/tests/runtime-asset-admission-postgres.spec.ts) cover concurrent shared locks, current forwarding issuers, exact-generation completion and revocation committed during an exclusive lock wait. The [Gateway performance reference](../../../../gateway/README.md#performance-and-runtime-admission) lists the timing fields for the Host and the owner Gateway.
