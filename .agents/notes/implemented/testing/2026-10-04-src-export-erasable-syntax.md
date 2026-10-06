# Agent Note: `./src/*` exports must carry erasable-only TypeScript

Status: implemented

English | [中文](2026-10-04-src-export-erasable-syntax.zh.md)

## Problem

`DSH_EXAMPLE_MODE=lib` — the mode `ci-snapshot` selects — launches example bins under plain Node. `.mjs` fixtures in those compositions import package internals through the published `./src/*` export, which resolves to raw `.ts` source and loads under Node's built-in type stripping. Strip-only mode accepts erasable syntax only: `import type`, `as`, annotations, and bare access-modifier fields are removed, while parameter properties, enums, and namespaces need real transforms and fail at parse time. `headless-agent`'s external fixtures failed `TypeScript parameter property is not supported in strip-only mode`, the Loader reported only `failed to import` ([`vendor/loader/src/config/entry.ts`](../../../../vendor/loader/src/config/entry.ts) logs the real error through `ctx.logger`, which the smoke does not surface), and the composed run ended `NO_ADAPTER`.

## Decision

Two invariants, kept in the packages where they were violated:

- **Erasable-only syntax under `./src/*`.** Any `.ts` file reachable through a published `./src/*` export must parse under strip-only mode. `subagent-codex`'s `member.ts`, `run.ts`, `wire.ts` and `subagent-acp`'s `index.ts`, `member.ts` moved constructor parameter properties to explicit field declarations plus assignment; `model?: string` became `model: string | undefined` because `exactOptionalPropertyTypes` does not admit `undefined` writes to an optional property. Behavior is unchanged.
- **Bare specifiers in source files resolve through real package resolution in lib mode.** `subagent-acp/src/run.ts` imported `@deepseek-ai/dsh-brand`, undeclared in the package manifest; tsconfig `paths` hid that in `src` mode, but lib mode applies pnpm's real dependency closure. `dsh-brand` is now declared in `peerDependencies` and `devDependencies` at `workspace:*`, matching sibling convention.

## Alternatives considered

- **Re-export the member classes from the package root.** Adds public surface so a fixture can subclass internals; rejected — the `./src/*` escape exists precisely so fixtures reach internals without widening the API.
- **Teach the fixture to import `lib/` artifacts.** `tsdown` bundles `member.ts` into `lib/index.js`; there is no `lib/member.js` to name, and depending on bundle shape is more fragile than source syntax.
- **Surface the Loader's import error in `failed to import`.** The diagnostic exists in `ctx.logger`; wiring it into the smoke's stderr would have saved an hour here but is separate work, not required for this fix.

## Consequences

New `.ts` sources placed under a `./src/*` export share the erasable-only constraint; the same failure mode appears for `enum`, `namespace`, or decorator use in that reachability class. `test:coverage` and package specs run through the `src` face and cannot detect it — only a `lib`-mode Loader smoke can.

## Related

- [`dsh-loader-smoke`](../../../../packages/test-support/loader-smoke/src/index.ts) documents the `src`/`lib` launch split in its `resolveExampleLaunch` contract.
