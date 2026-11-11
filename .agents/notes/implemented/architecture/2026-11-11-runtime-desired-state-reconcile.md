# Agent Note: Desired-state Runtime reconciler with bounded warmup

Status: implemented

English | [中文](2026-11-11-runtime-desired-state-reconcile.zh.md)

## Problem

A stopped local Runtime only ever came back through a user-facing request: upgrades drain survivors to `stopped`, the idle reaper stops quiet Runtimes, and a crashed supervisor is published `failed` — yet nothing restarted any of them. Every "open the UI and wait" after a deploy was a lazy cold start, and a permanently crash-looping Runtime (observed: one project row at generation 11228) could burn unbounded start attempts.

## Decision

`InstanceManager.reconcile()` runs once ~15s after boot and every 60s under the existing `fencedTask` single-flight, and performs two duties against the durable row set:

- **Probe**: for each adopted resident lease still `ready`, check the tracked proc (`isAlive`/`hasExited`) or reattach through `liveEndpoint`. A confirmed-dead process is stopped with reason `failed`; a missing resource registration (`unregistered`) is *not* treated as death — the probe only acts on positive evidence.
- **Warm**: `InstanceRepository.warmTargets(cutoff)` returns local `stopped` rows whose `stop_reason` is an infrastructure stop (`shutdown`, `idle`, `failed`) with `last_activity_at` inside `HGW_RECONCILE_WARM_WINDOW_MS` (default 7 days), most-recently-active first. Each is restarted through ordinary `ensureRunning(subject, 'passive')` — full admission, capacity, and policy path — with a minimal subject rebuilt by `warmSubject()` from `repository.owner`.

`manual` and `access-change` stops are never revived (excluded at the SQL level and by passive-intent semantics). A per-boot `reconcileRestarts` map caps warm attempts at `HGW_RECONCILE_MAX_RESTARTS` (default 3); exhausted targets count toward `budgeted` and wait for the next boot or a user request. `HGW_RECONCILE=off` disables the loop.

## Alternatives considered

**Supervisor-level respawn** (launchd/systemd-style restart on the supervisor unit). Rejected: respawn bypasses gateway admission, capacity fencing, and generation fencing; the reconciler reuses the ordinary start pipeline so a revived Runtime is indistinguishable from a user-started one.

**Warming every stopped row.** Rejected: cold, long-idle Runtimes would burn start slots on boot for spaces nobody opens. The activity window bounds the warm set to plausibly-used spaces; explicit `manual` stays untouched as a hard semantic line.

## Consequences

A deploy-restart now self-heals: signature drain → `stopped` rows with `stop_reason='shutdown'` → first reconcile tick warms them back `ready` with zero user-facing wait. Crash recovery is automatic within ~60s instead of waiting for the next entry, and crash loops are capped per boot — the historical runaway row moved from unbounded generation churn to exactly 3 attempts then `budgeted`. Warmed starts share the same admission FIFO as user requests, so a mass warm can transiently occupy `maxStarting` slots; interactive starts are not preempted but may queue behind an in-flight warm admission.

## Verification

- `instances.spec.ts` (+4): shutdown-stopped rows warm back `ready` while `manual`/`access-change` stay `stopped`; a real `FAKE_DSH` child killed via `/exit` is published `failed` then warmed back `ready`; a dead adopted survivor is published `failed` through the probe; `HGW_RECONCILE_MAX_RESTARTS=1` yields `budgeted` and leaves the row stopped (142/142 with config suite).
- `config.spec.ts`: defaults `enabled/7d/3`, `HGW_RECONCILE=off`, rejection of malformed values.
- Production mac-mini r56: boot signature drain → first reconcile logged `{ failed: 0, warmed: 5, budgeted: 0 }`, six rows (admin personal, mac-mini steward, project Runtimes) reached `ready` unattended; two crash-looping rows retried at ticks 2–3 (generations 24→25→26, 11229→11230→11231) then logged `{ budgeted: 2 }` and stopped retrying.
