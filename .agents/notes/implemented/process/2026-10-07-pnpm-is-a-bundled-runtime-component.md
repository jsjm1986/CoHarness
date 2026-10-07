# Agent Note: The pnpm dependency is a bundled runtime component

Status: implemented

English | [中文](2026-10-07-pnpm-is-a-bundled-runtime-component.zh.md)

## Problem

`pnpm` appears as an ordinary `devDependency` in the root `package.json` and in [`packages/boot/plugin-manager/package.json`](../../../../packages/boot/plugin-manager/package.json), so automated dependency updates treat it like any other package and propose major bumps (the 11.7.0 → 12.3.4 PR failed all 23 CI lanes). It is not an ordinary dependency: the npm package's bytes ship inside the Python runtime payload, and several build and test consumers invoke its JavaScript entrypoint directly. A major bump is a runtime-component swap, and pnpm 12 specifically is an architecture change — the npm package became a placeholder bin over per-platform `@pnpm/exe.*` binaries plus an install script, which the deny-by-default `allowBuilds` policy rejects at install, and whose `bin/pnpm.mjs` is no longer a runnable JavaScript implementation.

## Decision

The `pnpm` dependency stays on the 11.x line until a dedicated migration decides the bundled component's distribution form. [`.github/dependabot.yml`](../../../../.github/dependabot.yml) ignores `version-update:semver-major` for `pnpm` (minor and patch updates still flow), and the held major pull request was closed with this analysis attached.

Four consumers pin the JavaScript-entrypoint contract that a migration must satisfy or replace:

- [`scripts/primary-runtime/prepare.ts`](../../../../scripts/primary-runtime/prepare.ts) copies `require.resolve('pnpm')`'s package directory into the runtime payload as `dependencies/pnpm/`; [`primary-runtime.ts`](../../../../packages/boot/workspace-dependencies/src/primary-runtime.ts) resolves `dependencies/pnpm/bin/pnpm.mjs`, and `verify-installed` executes `node pnpm.mjs --version` to record the `pnpm` component version in the payload manifest.
- [`scripts/build-exe-for-python-sdk.ts`](../../../../scripts/build-exe-for-python-sdk.ts) `pnpmInvocation()` scans for `pnpm.mjs`/`pnpm.cjs` alone and fails when pnpm exposes no JavaScript entrypoint.
- [`manager.spec.ts`](../../../../packages/boot/plugin-manager/tests/manager.spec.ts) runs real installs as `node --expose-internals <pnpm.mjs>`; plugin-manager operations spawn `pnpm` externally and classify failures from its CLI output.
- [`python/sdk-runtime`](../../../../python/sdk-runtime/package.json) ships the copied package directory as part of the runtime payload.

The migration must choose a distribution form — a maintained JavaScript build, per-platform executables, or an externally supplied pnpm — then re-verify each consumer above, add the install-script allowlist entry, and audit plugin-manager's failure classification against the new CLI surface (pnpm 12 renamed error codes such as `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` to `ERR_PNPM_OUTDATED_LOCKFILE` and has documented reporter parity gaps).

## Alternatives considered

- **Allow `pnpm` in `allowBuilds` and take the bump.** Fixes only the install-time gate; the JavaScript-entrypoint consumers still break against the pacquet package, and an allowlist entry for a component we intend to hold weakens the gate's signal.
- **Close the major pull request without an ignore rule.** Dependabot reopens the same bump every schedule, re-litigating a settled decision.
- **Migrate to pnpm 12 now.** Premature: the distribution-form choice and parity audit are a dedicated effort, and the 11.x line remains maintained for the consumers listed above.
- **Drop the bundled pnpm and require deployments to supply it.** A distribution-contract change belonging to the same migration decision, not a workaround to unblock a version bump.

## Consequences

Dependabot no longer proposes pnpm majors, while minor and patch updates continue. The migration checklist — distribution form, `allowBuilds`, the four entrypoint consumers, CLI parity — is recorded here instead of being rediscovered per pull request. The same ignore mechanism holds `@vitejs/plugin-react` majors, whose version 6 requires `vite: ^8.0.0`; that gate is self-contained in the dependabot configuration comment and its closed pull request.
