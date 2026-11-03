# Agent Note: Gateway-owned model request admission

Status: implemented

English | [中文](2026-10-24-gateway-model-ownership.zh.md)

## Problem

Gateway utilities can issue inference without an executing Runtime. Project progress generation needs the same node scheduling as Runtime models, while retaining physical ownership across HTTP cancellation, database disconnects, process death and deployment quiescence.

## Decision

`GatewayModelBudget` registers a unique Gateway generation in the PostgreSQL node accountant. Its model requests share the existing pressure credits and equal-user/project queue. Manual requests retain their verified initiating user for scheduling; automatic sweeps use the infrastructure user, zero. Scheduled requests use only the model kind; administrative [destructive operations](../bug-fix/2026-10-28-project-deletion-lifecycle.md) retain the same process witness without scheduler credits. Its process death cannot establish that independent subprocess descendants have stopped.

Before registration, the owner holds a POSIX kernel lock on a unique file under the stable private `stateRoot/gateway-model-locks/<node-id>` directory. PostgreSQL retains its UUID, generation, device and inode. Recovery opens the existing file without following symlinks, verifies the descriptor and pathname against that witness, and attempts an exclusive nonblocking lock. Only a matching acquired lock authorizes reclaiming its reservations. Missing files, changed inodes, live locks and database disconnects provide no process-death evidence. Preserve this directory while Gateway processes run.

The owner serializes request registration, fences lost acknowledgements through the monotonic sequence, and waits for admission before invoking the HTTP callback. The callback owns fetching, bounded body consumption and cancellation. Completion releases accounting after the callback settles. Closing cancels model callbacks and joins all model and administrative callbacks; failed cleanup retains the lock and accounting for a retry or confirmed process-death recovery. This supplements the [Runtime-generation ownership decision](2026-10-23-gateway-runtime-admission.md).

Project progress rechecks maintenance/data generation, organization/node/project activity, the initiating writer, shared source visibility and the served model route after admission. Credentials resolve from the fresh route. Background manual passes count as control-plane writers through settlement, and shutdown joins both manual and scheduled work before closing their accountant or database pool.

## Alternatives considered

- Borrowing a project Runtime generation would let that Runtime's termination reclaim a Gateway HTTP request that remains alive.
- A heartbeat or expiring lease cannot distinguish a disconnected live process from a dead process. Running reservations require completion or kernel-lock evidence.
- One in-memory semaphore per Gateway would split fairness and reservations across coordinators and lose outstanding ownership on restart.

## Consequences

Gateway model ownership adds PostgreSQL migration 065 and a required native flock entry to the compiled Gateway payload. Release validation checks that entry only for builds importing the Gateway model owner, preserving older compiled rollback targets. Model calls in this owner do not gain subprocess containment.

The [progress journal decision](../feature/2026-10-21-project-progress-journal.md) owns request evidence, billing replay, source invalidation and publication generation checks. Infrastructure usage is charged to the project without fabricating a Session participant.

## Verification

Real PostgreSQL tests cover shared Runtime/Gateway ordering, queued cancellation, lost registration acknowledgements, live lock preservation and inode replacement. A source-launched child holds an unfinished loopback HTTP response, is killed with SIGKILL, and remains accounted until a matching kernel lock is acquired. Its interrupted request replays once as missing usage. The process-death case runs on the local macOS host; it does not establish Linux systemd Runtime containment.
