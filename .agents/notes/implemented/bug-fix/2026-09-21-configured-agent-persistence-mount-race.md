# Agent Note: Configured-agent persistence reads wait out pending Loader mounts

Status: implemented

English | [中文](2026-09-21-configured-agent-persistence-mount-race.zh.md)

## Problem

Loader entry groups mount children concurrently (`Promise.all` in `EntryGroup.update`), so a plugin's construction order follows module-import resolution, not tree position. `AgentLoop`'s configured-agent loop reads `ctx.get('sessionPersistence')` synchronously during construction: once at the `sessionId` branch to choose restore-vs-create, and once inside `createStoredSession` for every `create`/`createAgent`. `ctx.get` is a one-shot strict read — a backend whose module is still importing is invisible to it.

The failure mode is silent data loss: the configured agent publishes and runs normally, but its session never claims a write handle, so `session/flush` has no writer to drain and nothing durable is produced. A `dsh-session-persistence-jsonl` backend that imports after `agent-loop`'s injected dependencies resolve reproduces it deterministically — the keyless headless smoke under tsx (`DSH_EXAMPLE_MODE=src`) lost every run while the built-`lib` timing happened to win. The same race reaches user overlays that configure `agents:` with a late-mounting backend, and the `sessionId` variant additionally misroutes a restore-or-create into a plain `create`, which then collides with the existing artifact as `SessionAlreadyExistsError`.

## Decision

`AgentLoop` resolves the optional backend through `resolveSessionPersistence`: a strict `ctx.get`, and on a miss a single `ctx.get('loader')?.await()` — the Loader service's public settle wait, which drains every entry's pending import and fiber activation — followed by one re-read. The wait runs inside the tracked async startup, so the plugin constructor never blocks on its own mount.

The configured-agent constructor loop now delegates to `startConfigured`, which resolves persistence inside the async startup instead of reading synchronously at apply time. `createStoredSession` uses the same resolver, covering `create` and `createAgent` for both configured and runtime callers. `resume` keeps its strict read: it is a post-boot runtime API whose contract is to throw when no backend is configured, and the configured-resume path already waits correctly through `ctx.inject(['sessionPersistence'], ...)`.

## Alternatives considered

**Wait via `ctx.inject(['sessionPersistence'], ...)` for every configured agent.** Rejected: `inject` blocks forever when the composition genuinely has no persistence backend — an optional service cannot be a hard dependency — and re-fires on later HMR remounts, double-creating agents.

**Claim the handle lazily at `session/flush` or first `session/event`.** Rejected: by first-event time the seed window has already closed, so a late-adopted writer would start mid-log and fail the tracker's contiguous-seq validation; the pre-publication seed flush (`appendUnstoredSuffix`) exists precisely because those events never re-emit.

**Pin mount order through the overlay or fixture.** Rejected: patch entries cannot reorder sibling mounts, and the defect is a real product race for overlay-authored `agents:`, not test scaffolding — fixing it only in the fixture would leave the product path lossy. The fix is upstream-applicable; upstream `dsh-v0.1.6-alpha.2` carries the identical read.

**Await settle inside the `resume` runtime API too.** Deferred: its contract throws loudly on a missing backend, and no in-tree caller resumes during composition; the configured-resume path already waits through `ctx.inject`.

## Consequences

- Configured agents publish only after the composition settles enough to see a backend — startup takes the backend's mount time instead of silently dropping durability. Post-boot `create`/`createAgent` calls see an already-settled loader and pay one extra `ctx.get` only.
- A `sessionId`-configured agent now restore-or-creates against the real backend state instead of racing into a `SessionAlreadyExistsError` or an unpersisted duplicate.
- A composition with no backend behaves exactly as before: `loader.await()` returns once mounts settle, the re-read still misses, and the session runs unpersisted by design.
- Related: [the activation-audit note](../architecture/2026-09-17-loader-activation-audit-consumers.md) owns why `loader.await()` is only a settle signal — a failed backend stays absent after it resolves, which is the correct "no persistence" outcome here.
- Verified by `apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts` in both `src` and `lib` modes and the `agent-loop` package suite (379 tests).
