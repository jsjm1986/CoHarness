# Agent Note: Global Worker patches must attribute records to their spawn site

Status: implemented

English | [中文](2026-11-09-global-worker-patch-attribution.zh.md)

## Problem

`packages/experimental/inspector/tests/fixtures/managed-debugging.mjs` patches `require('node:worker_threads').Worker` to record every Worker the process constructs, then awaits `exit` on the records captured inside each combo's `before` window. On Windows CI the first combo deterministically hung for the entire 480s budget with the Inspector teardown fully quiet; master-era and POSIX lanes passed in seconds. Teardown marks showed every Inspector disposer, the graceful worker `shutdown`, and `fiber.dispose()` all completing, with the wait parked on the fixture's own `Promise.all(workers...completion)`.

## Decision

Worker records now carry the construction stack and a spawn-site classification: a record is an "inspector worker" when its stack contains an `inspector/` path segment. Completion waits, `closedByPolicy`, and the per-combo count assertions read only that filtered set, while the watchdog dump still reports every captured worker.

## Alternatives considered

- **Filter by script URL** (`data:` bootstrap vs file path) — the Inspector's src worker and lib worker have different target forms, while a foreign `data:` URL worker would mis-attribute; the stack segment is one predicate across launch modes.
- **Snapshot `workers.length` at composition start instead of per combo** — leaves later stray spawns inside every window and hides which combo introduced them.
- **Await a global `exit` on every record but bound it** — masks the defect the way a bare timeout would; the pool Worker the assertion actually caught is designed not to exit, so no bound distinguishes "slow" from "never".
- **Remove the Worker patch and assert only `outcome`/`status`** — loses the one signal that proves the Inspector's own worker exited rather than leaked.

## Consequences

The observed foreign record is tsx's esbuild `startWorkerThreadService` worker, spawned lazily on the first `transformSync`. On fast hosts that first transform runs during the `import(boot/app-boot)` warm-up, outside every combo window; on slow hosts it lands inside the first `loader.create`, so the `before` slice captured it. That timing axis — not a branch code change and not Inspector teardown — was the Windows/POSIX divergence and the within-branch nondeterminism. Any future process-level pool Worker (a resolver service, a bundler daemon, a test-runtime helper) gets the same treatment: attributed out of the assertion set, still visible in the watchdog dump.

The same pattern applies wherever a spec patches a process-global constructor (`Worker`, `ChildProcess`, `net.Socket`) and then asserts over a slice captured mid-scenario: the patch must classify records by spawn site, or slow hosts will let foreign lazy constructions fall inside the window.
