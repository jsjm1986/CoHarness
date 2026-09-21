# Agent Note: Profile resolution prefers ambient TypeScript-source results

Status: implemented

English | [中文](2026-09-21-profile-resolution-ambient-source-plane.zh.md)

## Problem

A source launch (`pnpm dsh`, `node --import tsx/esm`) installs `PluginPackages` runtime resolution, which routes profile-scoped bare specifiers to the selected generation's `packageDir`. The routed lookup anchors on the declarer's manifest inside `node_modules`, and tsx's tsconfig-`paths` hook does not remap imports whose importer lives under `node_modules`, so plugin entries resolved to `lib/index.js`. Once loaded, Node realpaths each module URL out of the profiles directory, so the plugin's own bare imports fell back to tsx `paths` and landed on `src/*.ts`. The process then ran two copies of every workspace package — plugin entry on the artifact plane, its dependencies on the source plane.

The composition still booted because vendored Cordis resolves through `paths` to `src` on both paths, keeping the service registry single. The first fatal seam was `TOOL_RUNTIME_SCHEDULER`: `ctx.tools` carried the `lib` copy's symbol while `agent-loop` compared against the `src` copy, so every tool call ended the turn with `UNKNOWN: Cannot read properties of undefined (reading 'prepare')`. Any `unique symbol` or `instanceof` contract across package copies splits the same way.

## Decision

`installProfileResolution` now probes ambient resolution before enforcing or verifying a route. `ambientSourceResult` re-resolves the request through the native loader from the original parent and keeps the result only when it lands on a TypeScript artifact (`ts`/`tsx`/`mts`/`cts`). A source-plane ambient hit wins over the routed artifact entry, so a source launch keeps plugin entries and their dependencies on one plane; a pure artifact launch sees ambient `.js` results and routes exactly as before. Enforce and verify behavior is unchanged — the probe precedes both and returns early only on a source hit.

`TOOL_RUNTIME_SCHEDULER` additionally uses `Symbol.for`, restoring the [process-stable symbol decision](2026-09-18-tool-scheduler-process-stable-symbol.md) that the alpha.2 merge reverted to `Symbol()`; the registry keeps the protocol slot stable against any residual copy split, while this probe removes the split itself for profile launches.

## Alternatives considered

**Route entries onto the source plane unconditionally.** Rejected: tsx `paths` is a source-launch detail; under a built install ambient resolution yields `lib`, and hard-routing to `src` would break artifact-plane launches.

**Unify the Loader's internal `import()` onto the ambient hook chain.** Rejected in the [process-stable symbol note](2026-09-18-tool-scheduler-process-stable-symbol.md): vendored-Loader surgery exceeds the defect, and upstream mounts entries identically — this is an upstream-applicable latent hazard.

**Rely on `Symbol.for` alone.** Rejected: it immunizes one protocol slot but leaves every other per-module identity (`instanceof`, private `Symbol()` keys, duplicated module state) split across copies; the composition must not mix planes at all.

## Consequences

- `pnpm dsh --profile headless` on a tree with built `lib/` runs a full tool round trip; previously it crashed on the first tool call after every `pnpm build`.
- Ambient misses (names unresolvable from the profile parent, or ambient `.js` results) fall through to the existing enforce/verify path unchanged, so artifact installs keep generation routing and its diagnostics.
- The probe adds one native `resolveSync` per uncached scoped request; resolved source results are cached in `state.esm` like routed results.
- Verified by `apps/cli/tests/profiles/headless/tests/source-launch.spec.ts`, which boots the real `bin.ts` through tsx, loads the shipped headless profile through `PluginPackages`, and completes a tool call — it fails against the pre-fix resolver — plus `packages/boot/app-boot` profile-resolution specs (63 tests) covering the ambient-source, non-source, and attribute-qualified branches.
