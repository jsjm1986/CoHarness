# Agent Note: hmr-live isolates dev:web from the lane's client artifacts

Status: implemented

English | [中文](2026-10-21-dev-web-skip-build-artifact-isolation.zh.md)

## Problem

`hmr-live.e2e.ts` launched `pnpm run dev:web` from a Vitest worker to prove a real client-plugin edit hot-reloads. `dev:web` runs `build:artifacts` before its watchers, and the spawn inherited the worker's `NODE_ENV=test`: the stage emitted test-mode bundles, rewrote `.dsh-build/client-build-environment.json` with their digest, and the test's byte restore of `lib/client*.js` and `apps/web/dist` could never match the record the stage left behind. Every later record consumer in the pooled lane — `built-boot.snapshot.ts` first — failed with an artifact-digest mismatch. A second, subtler leak remained even without the build stage: the teardown restored the edited `locales.ts` while the watchers were still alive, so the restore itself scheduled one more rebuild whose emit could land after the artifact restore and leave watch-mode bundles behind.

## Decision

The test now owns the boundary in both directions. The spawn runs `pnpm run dev:web --skip-build` so no stage reaches the artifacts or the record at all, and it passes `NODE_ENV=production` on top of the recorded client build environment as a guard for any future path that still reads the ambient variable. `.dsh-build/client-build-environment.json` is backed up beside the bundle and `dist` copies and restored in the same `finally`. Teardown order inverts: `stopTree(watcher)` runs before `writeFile(sourcePath, originalSource)`, so no live watcher can observe the restore and queue an emit that outlives the artifact restore.

## Alternatives considered

- **Let the build stage run and restore the record afterwards** — still correct on bytes, but the stage costs the test several seconds and emits artifacts the test immediately discards; skipping it is strictly better and removes the NODE_ENV hazard at the source rather than filtering it.
- **Restore the source first and rely on `stopTree` to kill the queued rebuild** — `stopTree` terminates the process tree it spawned, but a rebuild already dispatched can complete its write after the artifact restore; ordering the stop first removes the trigger rather than racing its consequence.
- **Recompute the record with `writeClientBuildRecord` in teardown** — would bake whatever digest the post-test tree happens to hold into the record, including leftover damage; restoring the remembered bytes keeps the failure visible instead of normalizing it away.

## Consequences

A record consumer can now trust that the digest it validated before the test still describes the tree after it. The test runs faster by one full `build:artifacts` pass. The contract for any future test that launches `dev:web` beside the lane's built artifacts: skip the build stage or own the record, control the spawned environment, and stop the watcher before touching the files it watches. `--skip-build` exists precisely for callers that arrive with artifacts already built; using it here keeps `dev:web`'s default (always rebuild) unchanged for humans.
