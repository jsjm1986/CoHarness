# Agent Note: Instance port conflict self-healing

Status: implemented

English | [中文](2026-11-11-runtime-port-reclaim.zh.md)

## Problem

Each instance owns a durable node-local port assigned at allocation; nothing re-checked it at spawn. A SIGKILLed supervisor left its orphaned `dsh` child holding the port, so the next generation hit `EADDRINUSE`, died inside the readiness deadline, and retried forever — one project row accumulated generation 11228 this way. The same loop blocked `LocalRuntimeControl.confirmStopped`, which reported the orphaned process group as 'occupied' indefinitely.

## Decision

Two evidence-bounded fixes at different layers:

- **Orphan reap in `confirmStopped`** (`local-runtime-control.ts`): on POSIX, when the record-bound `groupPid` group is alive but the leader (the supervisor itself) is dead, the survivors are this generation's own orphans — a live process group cannot host foreign members, and the pgid was minted by this record's spawn. The reap runs at **both** lease-acquisition failure (an orphaned `dsh` child inherits the supervisor's lease fd, so the lock stays held even after the supervisor dies) and inside the acquired confirmation (orphans without the fd). The group is `SIGKILL`ed and re-probed instead of reporting 'occupied' forever. Windows already sweeps orphans by parent link; linux-slice containment is unchanged.
- **Start-time port reclaim** (`instances.ts`): before `beginStart` spends a generation, `reclaimInstancePort` probes `127.0.0.1:{port}`. A refused or immediately-dropped connection is free — which also matches fixture relays that forward an accepted socket to the real child and destroy it when no upstream is published. Bytes returned, or a connection still held at the 1s deadline, count as an occupant. The occupied path first re-attaches through the owner record (`launcher.attach` + `terminate(PORT_RECLAIM_GRACE_MS)`) so a stale holder of this exact generation is reclaimed rather than abandoned; if the port stays occupied the holder is outside ownership evidence and `repository.reassignPort` allocates a fresh port (bounded at 3 attempts, each re-probed). Repositories without `reassignPort` fail the start loudly instead of looping `EADDRINUSE` through the readiness deadline.
- **`stopping` residue completion** (`reconcile`): a gateway restart abandons in-flight terminations and wedges rows in `stopping` forever (adopted leases then block starts with 'incomplete start or stop'). The reconcile probe finishes them under the row's *recorded* `stop_reason` — `manual`/`access-change` stay excluded from warmup; null reasons become `failed`.

`reassignPort` is implemented for PostgreSQL (`pg_advisory_xact_lock` + `allocateInstancePorts` + `UPDATE instances.port`, addressing by `public_id`/`runtime_id`) and SQLite (`MAX(port)+1` inside a transaction). The port is node-local addressing, not identity, so re-addressing is safe; clients resolve the runtime by public id.

## Alternatives considered

**PID inspection (`lsof`/`netstat`) to identify the occupant.** Rejected: platform-specific, parse-fragile, and slower than the owner-record evidence path; the record's nonce+token+lock-inode already authenticates our own stale holders, and anything else gets a fresh port instead of a kill decision.

**Probe by plain connect only.** A connect-accepted verdict cannot distinguish a fixture relay listener (expected holder that forwards to the real child) from a squatter. The dropped-empty-probe signal is what lets the same code serve both production and relay fixtures.

## Consequences

The kill-9-supervisor + lingering-child crash loop is now self-healing at two independent points: `confirmStopped` reaps the orphan group during any termination attempt, and `reclaimInstancePort` reclaims or re-addresses the port before spawning. Foreign port squatters no longer deadlock an instance — it moves to a fresh port and keeps its `ready` semantics. Residual gap: a squatter that accepts and instantly drops empty probes reads as 'free'; the child then fails to bind and surfaces through the normal readiness deadline, still bounded by the reconcile restart budget.

## Verification

- `instances.spec.ts` (+4): a foreign listener on the assigned port is bypassed via `reassignPort` and the runtime reaches `ready` on the new port; a stale holder terminated through `launcher.attach` owner evidence keeps the original port; a repository returning `undefined` from `reassignPort` fails the start with 'cannot be reassigned' and leaves the row `stopped`; a wedged `stopping` row completes under its recorded reason (103/103 file).
- Production mac-mini r57: a `kill -9` on supervisor `50219` left orphan `50222` (reparented to launchd, holding port `42016` **and the inherited lease fd**); after the fixed gateway booted, reconcile finished the wedged `stopping` row — `reapOrphanedGroup` SIGKILLed group `50219`, the lease freed, the row settled `stopped`/`failed`, then warm restarted it `starting` on the same `42016` port. Two duplicate-port rows (`42000` local vs remote-node) correctly probed free — port identity is node-scoped.
