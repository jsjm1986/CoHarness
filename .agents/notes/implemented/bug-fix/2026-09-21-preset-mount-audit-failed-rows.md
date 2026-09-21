# Agent Note: Preset mount audit settles rows and reports failed fibers

Status: implemented

English | [中文](2026-09-21-preset-mount-audit-failed-rows.zh.md)

## Problem

`mountPreset`'s activation audit (`inactiveRows`) reported only two unusable states: an entry with no fiber ("never started", an import failure) and an entry whose fiber lacked a required service ("waiting for X"). A third state slipped through: a row whose config validation or `apply` threw settles its fiber into `FiberState.FAILED` — the fiber exists and its declared injects resolve, so the audit passed it and the mount succeeded with a silently dead row.

The blind spot was not theoretical. An earlier rename changed `dsh-persona`'s config field from `text` to a required `prefix` but left `text:` in the shipped `minimal` and `cordis` presets. Both persona rows failed validation on every mount for weeks; the `minimal` preset ran with the full deployment prompt instead of its fixed persona (its `complete: true` and `includeRuntimeContext: false` never took effect), and the `cordis` preset silently lost its self-referential persona. Nothing failed loud until a web snapshot test noticed a runtime-context `user/message` that `includeRuntimeContext: false` exists to suppress.

## Decision

`inactiveRows` is now async and awaits each enabled entry's `fiber.await()` before checking injects. `await()` drains the fiber's in-flight activation and rethrows its recorded failure, so a settled-failed row reports `id (name): <error>` in the mount rejection instead of passing. A row pending forever on missing injects has no in-flight work, returns immediately, and still reports through the existing `waiting for` check — no hang is added for the state the audit already covered.

The two shipped presets' persona rows use `prefix:`, restoring the `minimal` complete-prompt/runtime-context suppression contract and the `cordis` preset persona.

## Alternatives considered

**Check `fiber.state === FiberState.FAILED` synchronously.** Rejected: entry fibers activate asynchronously, so at audit time a doomed row may still be `LOADING`; a synchronous read misses failures that land a microtask later. Awaiting settle is the only race-free read of the failure state.

**Leave the audit as-is and fix only the stale fields.** Rejected: the stale fields survived precisely because nothing observed the dead rows. Any future config-schema rename would reintroduce the same silent failure; [the activation-audit decision](../architecture/2026-09-17-loader-activation-audit-consumers.md) already owns the rule that consumers audit entry state because `loader.await()` no longer implies activation.

**Restore the `text` config alias in `dsh-persona`.** Rejected: the field was deliberately renamed upstream; keeping an alias would preserve a second name for one value with no current consumer besides the stale files themselves.

## Consequences

- A preset row whose config or `apply` fails now rejects the whole mount with the row's id, specifier, and validation detail — matching the audit's existing "names every failed row" contract for import failures.
- `inactiveRows` returns `Promise<string[]>`; its only caller (`mountPreset`) awaited it.
- The `cordis` preset's system prompt changes to its authored persona text (previously the deployment default silently rendered); no snapshot pinned the dead behavior.
- New fixture coverage: `bad-config` preset plus `rejects-config` plugin pin the settle check in `mount.spec.ts` (48 tests).
