# Agent Note: pnpm hoisted-installer fix through a compatible 11.x distribution

Status: implemented

English | [中文](2026-10-08-pnpm-hoisted-installer-fix.zh.md)

## Problem

pnpm's hoisted linker had an upstream rename race (pnpm/pnpm#12880): concurrent hoist-copies whose destinations nest could let a parent's swap-rename carry off a sibling's staged `_tmp_*` directory, and the loser exited `ERR_PNPM_ENOENT`. Warm retries did not help reliably, so [scripts/wine-windows-gates.sh](../../../../scripts/wine-windows-gates.sh) carried a `taskset -c 0` CPU-affinity pin plus an `ERR_PNPM_ENOENT` retry loop to serialize staged renames — a Linux-only workaround around a live installer defect rather than a fix. Upstream repaired the nested hoist operation itself in pnpm 11.28.4 (pnpm/pnpm#14242). The same release also changed where ignored build scripts are recorded: instead of writing undecided `allowBuilds` placeholders into `pnpm-workspace.yaml`, pnpm records them in `node_modules/.modules.yaml` and reports them through `pnpm ignored-builds`, so the plugin manager's placeholder-based pending-build discovery missed them under that record.

## Decision

The repository pins `pnpm@11.28.4` in the root and `native/system` `packageManager` fields and in the root devDependency and [`packages/boot/plugin-manager/package.json`](../../../../packages/boot/plugin-manager/package.json) devDependency — a compatible 11.x release carrying the upstream copy fix; the plugin manager also depends on `@pnpm/building.policy` at runtime so the approval path below evaluates pnpm's own rules. The Wine gate script performs a single immutable install without the affinity pin or rename-retry loop and still reports the `install.log` tail on failure. [`scripts/pnpm-runtime-component.spec.ts`](../../../../scripts/pnpm-runtime-component.spec.ts) contracts the distribution shape: identical pins across both `packageManager` fields and both dev declarations, `require.resolve('pnpm')` reaching the package metadata, no install-time lifecycle scripts, and `bin/pnpm.mjs` launching under `process.execPath` — including a relocated payload copy without a `PATH`.

On a failed plugin installation the plugin manager calls `capturePendingBuilds` before file rollback: it reads the workspace policy and `node_modules/.modules.yaml`, evaluates pnpm's own rules through the maintained `@pnpm/building.policy` package (`createAllowBuildFunction`, `unapprovedIgnoredBuilds`, `allowBuildKeyFromIgnoredBuild`), persists the undecided keys as undecided placeholders under the profile lock, and never rewrites an existing true/false decision. The durable `allowBuilds` entries therefore survive rollback and `node_modules` cleanup, and the approval surface keeps validating pending keys rather than matching source selectors itself.

The 11.x line keeps the bundled-JavaScript distribution contract: `exports['.']` resolves `package.json`, `bin/pnpm.mjs` imports the shipped `dist` bundle, and no `preinstall`/`install`/`postinstall` hook runs at payload install, so the deny-by-default `allowBuilds` policy needs no exemption. The pnpm 12 major hold from [pnpm is a bundled runtime component](2026-10-07-pnpm-is-a-bundled-runtime-component.md) is unchanged — its distribution-form and CLI-parity audit remains a separate migration decision.

The Python runtime deployment disables implicit workspace hoists while retaining its declared workspace dependencies. The deploy tree therefore contains the runtime closure rather than the synthetic carrier's self-link or unrelated workspace aliases. Materialization unlinks each proven package link before copying its files. The manylinux addon rebuild invokes the installed node-pty package's explicit install script with automatic dependency verification disabled; published npm artifacts do not contain that package's development-only TypeScript preparation inputs.

## Alternatives considered

- **Keep the taskset pin.** It serializes the entire install behind `availableParallelism()-1` wherever it applies and leaves the race live in every other hoisted-install consumer.
- **Vendor or patch the copy fix locally.** Duplicating upstream's concurrent-rename logic would hand-roll a filesystem layer the maintained distribution already fixed and reviewed.
- **Jump to pnpm 12.** Its npm package is a placeholder bin over per-platform `@pnpm/exe.*` binaries plus an install script — the distribution-form break the bundled-component note holds behind a dedicated migration, not this fix.
- **Stay on 11.7.0.** The race would keep requiring consumer-side mitigations, and the ignored-builds contract stays aligned with the maintained policy API on 11.28.4.
- **Reimplement depPath/selector matching.** `pnpm-workspace.yaml` rules accept registry names, exact `name@version` keys, and git/file dep-path keys whose semantics differ; `@pnpm/building.policy` owns that evaluation so approvals cannot widen a denied file-source build by bare name.

## Testing

[`scripts/pnpm-runtime-component.spec.ts`](../../../../scripts/pnpm-runtime-component.spec.ts) contracts the pins, distribution metadata, entrypoint execution, relocation, and the Wine pipeline shape; [`packages/boot/plugin-manager/tests/build-approval.spec.ts`](../../../../packages/boot/plugin-manager/tests/build-approval.spec.ts) exercises the policy contract including capture, denials, and malformed module state; `manager.spec.ts` runs the real pinned pnpm through a blocked install, approval, and retry build; [`apps/web/tests/plugin-install-approve.e2e.ts`](../../../../apps/web/tests/plugin-install-approve.e2e.ts) covers the assembled browser scenario end to end; [`scripts/client-tsconfig.spec.ts`](../../../../scripts/client-tsconfig.spec.ts) asserts through compiler-parsed project inputs that every Host-owned web e2e root, including that scenario, stays out of the client program.

## Consequences

Hoisted installs run on the fixed copy code without affinity plumbing or rename retries, and failed plugin installs keep offering their pending build approvals while pnpm keeps that record in module state rather than workspace policy. Local verification covers the pin contract, the relocated JS entrypoint, the capture/approval path, and the scripted pipeline; the hosted Wine and platform lanes provide the runtime proof the local Mac cannot. The bundled-pnpm note keeps its independent major-hold and migration checklist; [dual Wine and native Windows pull-request CI](2026-08-08-native-windows-pull-request-ci.md) keeps its lane topology; [current-profile plugin management](../architecture/2026-09-14-current-profile-plugin-management.md) keeps owning the approval UX and consent rules.
