# Agent Note: Consumers audit activation instead of catching transactional rollback

Status: implemented

English | [中文](2026-09-17-loader-activation-audit-consumers.zh.md)

> Applies the [app-boot non-transactional reload adaptation](../../../../packages/boot/app-boot/README.md) to the remaining Loader consumers migrated for dsh-v0.1.6-alpha.1.

## Problem

The vendored Cordis upgrade removed the transactional Loader promise: a plugin tree no longer rolls back to a previous tree when an entry fails during composition. Entry-level failures — import errors, config-validation rejections, an `apply` that throws — record the failure on the entry's fiber (`FiberState.FAILED`) or leave the entry unloaded, while unrelated entries still activate and `loader.await()` resolves. Consumers and tests written against the old contract broke in three ways:

- Awaiting `rejects.toThrow(...)` on a composition that now resolves; Vitest's pretty-format then printed the resolved `Context` proxy and crashed with `cannot get property "$$typeof" without inject`, masking the real behavioral change.
- TypeScript rejected `.catch()`/`await` on void-returning Loader APIs (`Fiber.update()`, `EntryTree.remove()`).
- Notes and tests still referenced `hmr-config.spec.ts`, deleted when its coverage moved to `watch-config.spec.ts`.

## Decision

Consumers observe activation instead of catching rollback, mirroring app-boot's startup audit (`auditStartupEntries` since dsh-v0.1.6-alpha.2, which adopted the same model upstream as `StartupError` plus structured `inactiveEntries` diagnostics):

- `packages/client/web/src/boot-client.ts` keeps the failure path inside the audit: a row whose module cannot be imported records the failure in the Loader, the boot page reports the row `failed`, and `assertEntriesActive` rejects boot with the `N entr… did not activate` report.
- `packages/todo/tool-todo/tests/loader-composition.spec.ts` pins misconfiguration without rollback: with `allowParallelInProgress` missing or non-boolean, the tool entry's fiber reaches `FiberState.FAILED` while the rest of the tree activates, so `todo_write` never mounts.
- `packages/extensions/cordis-client-runner/src/client/runtime.ts` retains the entry fiber before removal and waits for its teardown. The late-cleanup path contains removal errors and always disposes the injected styles.
- The four bilingual notes referencing `hmr-config.spec.ts` now name its successor `watch-config.spec.ts`.

The directory-picker-auto chooser fails its own fiber when an imported entry has no fiber, without retrying the import. It removes both owned entries and waits for their fibers to finish teardown, including entries already removed by the tree. Its composition tests verify service absence after failure and delayed teardown on unload.

## Alternatives considered

**Restore composition rejection with a transactional wrapper in app-boot.** Rejected: it would reintroduce the rollback guarantee the upstream upgrade deliberately removed and diverge from the vendored Loader's observable behavior.

**Assert only on error text inside fibers.** Rejected: `fiber.error` is not populated for tree-level failures, and message text is a weaker contract than the entry state the activation audit already owns.

## Consequences

- Resolution of `loader.await()` no longer implies activation; every boot path audits or renders per-entry state afterward.
- Loader-facing removal and update calls are unwrapped at call sites; cleanup must not depend on awaitable removal.
- Load-time rejection assertions become fiber-state assertions plus downstream service-absence checks; the old failure texts survive only as apply errors inside fibers.
- Verified shipped: `tsc -b` exit 0 for `cordis-client-runner`; focused suites green for `runner.client.spec.ts` (31), `boot-client.client.spec.ts` (6), and `tool-todo/loader-composition.spec.ts` (4). Phase 1 closed with `pnpm run test` exit 0 under Python 3.12 (1067 files, 18075 tests, 116 skipped), `pnpm run build` and `pnpm run typecheck` exit 0; the vendored HMR config watcher (Chokidar 4.0.3) passed its 11 native cases in the same full run, and the three earlier 5-second timeout files passed focused serial (42) and verbose (9) reruns with no timeout, assertion, or timeout-configuration change.