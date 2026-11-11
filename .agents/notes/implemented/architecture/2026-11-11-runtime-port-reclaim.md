# Agent Note: Instance port conflict self-healing

Status: implemented

English | [中文](2026-11-11-runtime-port-reclaim.zh.md)

## Problem

Each instance owns a durable node-local port assigned at allocation; nothing re-checked it at spawn. A SIGKILLed supervisor left its orphaned `dsh` child holding the port, so the next generation hit `EADDRINUSE`, died inside the readiness deadline, and retried forever — one project row accumulated generation 11228 this way. The same loop blocked `LocalRuntimeControl.confirmStopped`, which reported the orphaned process group as 'occupied' indefinitely.

## Decision

Two evidence-bounded fixes at different layers:

- **Orphan reap in `confirmStopped`** (`local-runtime-control.ts`): on POSIX, when the record-bound `groupPid` group is alive but the leader (the supervisor itself) is dead, the survivors are this generation's own orphans — a live process group cannot host foreign members, and the pgid was minted by this record's spawn. The reap runs at **both** lease-acquisition failure (an orphaned `dsh` child inherits the supervisor's lease fd, so the lock stays held even after the supervisor dies) and inside the acquired confirmation (orphans without the fd), and only for records of the *current* kernel boot — an earlier-boot record can outlive a machine restart and its stored pgid may name an unrelated group after PID reuse. The group is `SIGKILL`ed and re-probed instead of reporting 'occupied' forever. Windows already sweeps orphans by parent link; linux-slice containment is unchanged.
- **Start-time port reclaim** (`instances.ts`): before `beginStart` spends a generation, `reclaimInstancePort` probes `127.0.0.1:{port}`. A refused or immediately-dropped connection is free — which also matches fixture relays that forward an accepted socket to the real child and destroy it when no upstream is published. Bytes returned, or a connection still held at the 1s deadline, count as an occupant. A row at this point is `stopped` and its credential hash was cleared by `markStopped`, so no owner evidence can attribute the holder — the holder is outside our evidence by construction. `repository.reassignPort` then allocates a fresh port (bounded at 3 attempts, each re-probed). Repositories without `reassignPort` fail the start loudly instead of looping `EADDRINUSE` through the readiness deadline.
- **`stopping` residue completion** (`reconcile`): a gateway restart abandons in-flight terminations and wedges rows in `stopping` forever (adopted leases then block starts with 'incomplete start or stop'). The reconcile probe finishes them on the serialized per-runtime lane under the row's *recorded* `stop_reason`, fenced to the observed generation — a racing replacement start is never cancelled or stopped; `manual`/`access-change` stay excluded from warmup; null reasons become `failed`.

`reassignPort` is implemented for PostgreSQL (`pg_advisory_xact_lock` + `allocateInstancePorts` + `UPDATE instances.port`, addressing by `public_id`/`runtime_id`) and SQLite (`MAX(port)+1` inside a transaction). The port is node-local addressing, not identity, so re-addressing is safe; clients resolve the runtime by public id.

## Alternatives considered

**PID inspection (`lsof`/`netstat`) to identify and kill the occupant.** Rejected: platform-specific, parse-fragile, and any kill verdict aimed at a foreign process needs stronger evidence than a port binding can carry — the gateway re-addresses instead of judging. The only legitimate kill targets are our own generation's orphans, which `confirmStopped` already handles through record-bound pgid evidence.

**Owner-evidence re-attach of the stale holder.** Tried and removed: the row reaching this code is always `stopped`, and `markStopped` clears `runtime_token_hash`, so the credential needed to authenticate a holder of this generation never exists here — the branch was unreachable in production and only appeared to work in a test that stubbed `credentialHashOf`.

**Probe by plain connect only.** A connect-accepted verdict cannot distinguish a fixture relay listener (expected holder that forwards to the real child) from a squatter. The dropped-empty-probe signal is what lets the same code serve both production and relay fixtures.

## Consequences

The kill-9-supervisor + lingering-child crash loop is now self-healing at two independent points: `confirmStopped` reaps the orphan group during any termination attempt, and `reclaimInstancePort` re-addresses the port before spawning. Foreign port squatters no longer deadlock an instance — it moves to a fresh port and keeps its `ready` semantics. Residual gap: a squatter that accepts and instantly drops empty probes reads as 'free'; the child then fails to bind and surfaces through the normal readiness deadline, still bounded by the reconcile failure backoff.

## Verification

- `instances.spec.ts`: a foreign listener on the assigned port is bypassed via `reassignPort` and the runtime reaches `ready` on the new port; a repository returning `undefined` from `reassignPort` fails the start with 'cannot be reassigned' and leaves the row `stopped`; a wedged `stopping` row completes under its recorded reason through the generation-fenced lane.
- Production mac-mini r57: a `kill -9` on supervisor `50219` left orphan `50222` (reparented to launchd, holding port `42016` **and the inherited lease fd**); after the fixed gateway booted, reconcile finished the wedged `stopping` row — `reapOrphanedGroup` SIGKILLed group `50219`, the lease freed, the row settled `stopped`/`failed`, then warm restarted it `starting` on the same `42016` port. Two duplicate-port rows (`42000` local vs remote-node) correctly probed free — port identity is node-scoped.
