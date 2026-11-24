# Agent Note: Publish the cancellation fixture's pid file atomically

Status: implemented

English | [中文](2026-11-25-native-cancel-pid-file-atomic-publish.zh.md)

## Problem

`packages/util/native-command/tests/failed-spawn.spec.ts` failed on the hosted Linux coverage lane with exactly one mismatched field: the `during-live` scenario recorded `helperRunningAfterReturn: true` where the snapshot demands `false`. The product contract cannot produce that outcome — `runNativeCommand` delivers SIGKILL on abort and settles only after the child's `close` event, which implies the helper is dead and reaped before the caller continues. The measurement itself was racy: the fixture helper publishes its pid with `writeFileSync`, an open/write/close sequence during which the file exists while still empty. The readiness watcher fires on existence, and under host contention the fixture can read the empty file: `Number('')` is `0`, and `process.kill(0, 0)` is a POSIX probe of the caller's own process group — which always exists — so the liveness check reports `true` regardless of the helper's actual state.

## Decision

The helper now writes the pid to a sibling `.tmp` file and `renameSync`s it onto the watched path, so the path the watcher confirms exists only in its complete state. The cancellation contract under test — SIGKILL on abort, settlement after closure — is unchanged, as is the single-shot post-return liveness probe; with a truthful positive pid, `ESRCH` after `close` is a genuine guarantee rather than a race.

## Alternatives considered

- **Poll `process.kill(pid, 0)` instead of a single shot** — would make the probe itself flaky-tolerant but also reintroduce a real race: a correct product settles after reaping, so any observed liveness is measurement corruption, and polling would paper over corrupted input rather than exclude it.
- **Validate `pid > 0` and retry the read** — converges to the same outcome through more moving parts; atomic publish removes the invalid state entirely instead of detecting it.
- **Treating this as a product quiescence regression** — ruled out by construction: settlement is chained on `close`, and `close` after SIGKILL means the process no longer exists.

## Consequences

Any future fixture that publishes small control values through the filesystem for cross-process tests must treat publication as atomic — write-then-rename or an equivalent single-call primitive — because directory watchers observe existence, not completion. Related: [ptc cancellation probe yield](../testing/2026-11-25-ptc-cancel-probe-must-yield.md) covers the same test-design class on the Windows lane.
