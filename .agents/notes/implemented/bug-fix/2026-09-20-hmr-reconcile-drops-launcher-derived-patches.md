# Agent Note: HMR reconciliation re-derives launcher patches

Status: implemented

English | [中文](2026-09-20-hmr-reconcile-drops-launcher-derived-patches.zh.md)

## Problem

`dsh web` mounts `agent-presets` with the shipped preset root prepended into `config.roots` by `resolveShippedPresetPatch`, a launcher patch computed in `runProfile` and pushed onto the boot patch list. Seconds into every boot the roster silently emptied (`preset "ptc" not found (available: none)` on session resume): the HMR config watcher fires `add` events for existing files at startup (`ignoreInitial: false`), its refresh re-reads only the disk-backed patch layers via `readProfilePatches`, and `reconcileProfilePatches` replaces the root Include's entire `patches` array with that list. The recomposed tree reached the `agent-presets` entry without the launcher patch, so `entry.update` reloaded the fiber with `config.roots` back to the schema default `[]`.

## Decision

`ProfileContext` carries `derivePatches`, a callback `readProfilePatches` invokes against each freshly composed row set and appends to the returned generation. `runProfile` implements it with `resolveShippedPresetPatch`, so boot, HMR reconciliation, and any future re-read derive the shipped-root patch from the rows actually being applied — the per-generation derivation [the roster note](../architecture/2026-08-29-derived-shipped-preset-root.md) already prescribed, now enforced where the patches are read instead of where they are first consumed. Deriving per read — rather than storing the resolved patch — keeps a user's later `cordis.patch.yml` edits to the same row (`default`, additional `roots`) from being overwritten by a boot-time snapshot.

## Alternatives considered

**Push the resolved patch into `context.overlays` once.** Rejected: the stored patch embeds the boot-time row config; an HMR re-application would revert user edits made after boot to `agent-presets` `default` or `roots`.

**Persist the patch into the profile's `cordis.patch.yml` on disk.** Rejected: the file is user-owned; writing launcher internals into it couples deployment state to user edits and duplicates the shipped root on every checkout path change.

## Consequences

Any launcher-derived patch must flow through `derivePatches` to survive HMR reconciliation — `reconcileProfilePatches` treats the returned list as the complete patch set, so layers invisible to `readProfilePatches` are dropped on the first config-file event after boot. The telemetry patch already followed this rule by re-deriving inside `readProfilePatches`; `derivePatches` extends the same guarantee to app-computed patches.

## Testing

`dsh web --profile web` boots the roster with `config.roots = [shipped, user]` and the roster stays populated through the startup HMR sweep — sending a message resumes the session instead of failing `available: none`. `apps/cli/tests/shipped-preset-root.spec.ts` covers the derivation itself.
