# Agent Note: Desired-state Runtime reconciler with bounded warmup

Status: implemented

English | [中文](2026-11-11-runtime-desired-state-reconcile.zh.md)

## Problem

A stopped local Runtime only ever came back through a user-facing request: upgrades drain survivors to `stopped`, the idle reaper stops quiet Runtimes, and a crashed supervisor is published `failed` — yet nothing restarted any of them. Every "open the UI and wait" after a deploy was a lazy cold start, and a permanently crash-looping Runtime (observed: one project row at generation 11228) could burn unbounded start attempts.

## Decision

`InstanceManager.reconcile()` runs once ~15s after boot and every 60s under the existing `fencedTask` single-flight, and performs two duties against the durable row set:

- **Probe**: for each adopted resident lease still `ready`, check the tracked proc (`isAlive`/`hasExited`) or reattach through `liveEndpoint`. A confirmed-dead process is stopped with reason `failed` on the serialized per-runtime lane against the *observed* generation — a racing replacement start is never cancelled or terminated — and a missing resource registration (`unregistered`) is *not* treated as death; the probe only acts on positive evidence. An adopted lease whose row is still `starting` past `HGW_READINESS_TIMEOUT_MS` is settled the same way: the deadline is the launch promise's own budget, so an expired `starting` generation can never publish `ready` again — it only exists because the launch path itself died mid-start (observed on the Windows node: supervisor exit-0 during a Gateway restart left the row `starting` and its adopted lease fenced every later start with `RuntimeStartBlockedError`). A launch that died before the supervisor claimed owner evidence has provably no supervised process, so that edge settles the row and releases the lease directly.
- **Warm**: `InstanceRepository.warmTargets(cutoff)` returns local `stopped` rows whose `stop_reason` is an infrastructure stop (`shutdown`, `failed`) with `last_activity_at` inside `HGW_RECONCILE_WARM_WINDOW_MS` (default 7 days), most-recently-active first. Each is restarted through `startRequest(subject, 'passive', undefined, { recordActivity: false })` — full admission, capacity, and policy path with a minimal subject rebuilt by `warmSubject()` from `repository.owner` — but `beginStart` leaves `last_activity_at` untouched so an unattended warm cannot renew its own warm window.

`manual`, `access-change`, and `idle` stops are never revived: the first two are hard semantic lines, and an `idle` stop is the reaper's on-demand verdict — warming it would fight the policy that stopped it. A `reconcileRecovery` map applies consecutive-failure backoff: confirmed deaths and launch failures count, refusals (`blocked`, capacity `cancelled`) only defer one base interval, and the retry delay doubles per failure from `HGW_RECONCILE_BACKOFF_BASE_MS` (60s) to `HGW_RECONCILE_BACKOFF_MAX_MS` (30m); staying ready for `HGW_RECONCILE_STABLE_MS` (10m) closes the streak. `HGW_RECONCILE=off` disables the loop.

## Alternatives considered

**Supervisor-level respawn** (launchd/systemd-style restart on the supervisor unit). Rejected: respawn bypasses gateway admission, capacity fencing, and generation fencing; the reconciler reuses the ordinary start pipeline so a revived Runtime is indistinguishable from a user-started one.

**Warming every stopped row.** Rejected: cold, long-idle Runtimes would burn start slots on boot for spaces nobody opens. The activity window bounds the warm set to plausibly-used spaces; explicit `manual` stays untouched as a hard semantic line.

**A per-boot attempt cap.** Rejected: an absolute per-boot counter permanently starves a flaky Runtime until the next deploy and charges refusals that consumed no generation. Failure-scoped exponential backoff bounds churn without an end state, and a sustained-ready observation proving recovery clears it.

## Consequences

A deploy-restart now self-heals: signature drain → `stopped` rows with `stop_reason='shutdown'` → first reconcile tick warms them back `ready` with zero user-facing wait. Crash recovery is automatic within ~60s instead of waiting for the next entry, and a crash loop settles into geometric retries instead of unbounded churn or a hard per-boot stop — the historical runaway row now retries at most once per 30 minutes once the backoff saturates. A warmed-but-unused Runtime keeps its original `last_activity_at`, so the idle reaper retires it exactly once to `idle`, after which it stays stopped until real use. Warmed starts share the same admission FIFO as user requests, so a mass warm can transiently occupy `maxStarting` slots; interactive starts are not preempted but may queue behind an in-flight warm admission.

## Verification

- `instances.spec.ts`: `shutdown`-stopped rows warm back `ready` while `manual`/`access-change`/`idle` stay `stopped`; a real `FAKE_DSH` child killed via `/exit` is published `failed` then warmed back `ready`; a dead adopted survivor is published `failed` through the probe; a dead probe against a generation already replaced by a racing start terminates nothing; a `starting` generation past its readiness deadline is settled `failed` while a fresh one is left to its own launch; a warmed start leaves `last_activity_at` untouched; consecutive launch failures defer geometrically and a sustained-ready observation clears the streak.
- `config.spec.ts`: defaults `enabled/7d/60s/30m/10m`, `HGW_RECONCILE=off`, rejection of malformed values.
- Production mac-mini r56 (pre-backoff build): boot signature drain → first reconcile logged `{ failed: 0, warmed: 5, budgeted: 0 }`, six rows (admin personal, mac-mini steward, project Runtimes) reached `ready` unattended; two crash-looping rows retried at ticks 2–3 (generations 24→25→26, 11229→11230→11231) then stopped retrying. The drain→warm path the backoff now gates is unchanged.
