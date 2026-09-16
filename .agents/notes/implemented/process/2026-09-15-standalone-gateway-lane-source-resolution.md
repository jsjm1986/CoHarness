# Agent Note: Workspace source resolution in the standalone Gateway CI lanes

Status: implemented

English | [中文](2026-09-15-standalone-gateway-lane-source-resolution.zh.md)

## Problem

The `gateway` and `gateway-admin-ui` pull-request lanes install only `gateway/package-lock.json` and `gateway/admin-ui/package-lock.json` with `npm ci`; the root pnpm install and the workspace's emitted `lib/types` do not exist there. Gateway sources still import workspace packages directly from `src`, and the admin surface re-exports workspace component sources, so the lanes must resolve those imports without the repository's own install and build faces.

## Decision

Each resolution boundary gets the smallest face that produces the artifact the lane actually needs.

`gateway/tsconfig.json` maps `@deepseek-ai/*` specifiers through `paths` only for workspace sources that compile under the Gateway's strict flags. Modules whose sources do not — vendored Cordis builds under its own relaxed tsconfig, and the Typert protocol keeps a likewise distinct checking face — are declared once in `gateway/src/workspace-modules.d.ts` as ambient merge targets, so module augmentations in the reached sources still type-check while production builds resolve the real emitted declarations through node_modules.

`gateway/tsconfig.ci.json` extends the same `paths` and emits the full reached source graph into a scratch `lib-ci` directory. The lane runs it as `npm run build:check` in place of the production `npm run build`, which resolves workspace packages through their emitted `lib/types` and cannot succeed in a standalone checkout.

`plugins/dsh-directory-guard/tsconfig.ci.json` emits the policy bundle transpile-only (`noCheck`, no ambient `types`) because Gateway tests materialize `package.json` plus `lib/` into staged instance homes and never execute the plugin; type fidelity stays with the base configs once the workspace is built. The step runs the Gateway's own installed `tsc`, so the lane needs no pnpm.

Two runtime resolutions stay explicit in the workflow rather than hiding behind package layout: `loadConfig`'s source-run default resolves `tsx/esm` to an absolute path under the repo root, so the lane installs the root `tsx` devDependency into a scratch prefix and copies it into `node_modules/`; and the admin UI lane installs the third-party packages that re-exported workspace sources import (`anser`, `clsx`, `immer`, `zustand`, versions read from their owning manifests) the same way. Inside `gateway/admin-ui/vite.config.ts`, `server.deps.inline` keeps `zustand` in the Vite pipeline: an externalized copy would resolve its `react` import outside the `dedupe` map and load a second React instance.

## Alternatives considered

A root `pnpm install` plus filtered workspace builds inside these lanes was rejected: it turns a seconds-long independent lane into a multi-minute workspace build and re-couples Gateway checks to the full repository toolchain the lanes exist to avoid. Compiling the vendored and Typert sources under the Gateway's strict flags was rejected because those packages own relaxed checking faces by design. Running the plugin's real `tsconfig.build.json` in the lane was rejected for the same reason its `lib/types` paths cannot exist there.

## Consequences

- The standalone lanes reproduce a clean `npm ci` checkout faithfully: every workspace import either compiles from source or is explicitly declared ambient, and every runtime dependency the reached graph needs is provisioned at the repository root.
- Adding a new workspace source import to Gateway code either compiles under the existing `paths` or requires a deliberate ambient declaration; it cannot silently pass through an installed transitive copy.
- The ambient declarations cover only what the reached sources merge into. Widening them to fake full packages would hide real resolution failures, so new needs extend the file rather than bypass it.

## Verification

- `npm run typecheck --prefix gateway` and `npm run build:check --prefix gateway` pass on a clean `npm ci` tree with no root install.
- `gateway/node_modules/.bin/tsc -p plugins/dsh-directory-guard/tsconfig.ci.json` emits `lib/` and exits 0.
- `npm test --prefix gateway` passes in the same tree once the root `tsx` install is provisioned and the directory-guard bundle is emitted.
- `npm test --prefix gateway/admin-ui` and `npm run build --prefix gateway/admin-ui` pass once the four repo-level dependencies are provisioned.
