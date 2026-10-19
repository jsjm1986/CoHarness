# Agent Note: experimental claude-code-mods extraction and deferred upstream packages

Status: implemented

English | [中文](2026-10-17-experimental-claude-code-mods-extraction.zh.md)

## Problem

The upstream rc.2 tree carries eleven `packages/experimental/` packages that this fork lacks. Which of them port cleanly onto the fork's seams, and which rest on upstream-only subsystems the alignment campaign deliberately excludes?

## Decision

Land the pair whose dependencies resolve inside the fork, and defer the rest with named blockers:

- **`claude-code-mods`** — the mod bridge: `defineMod` registry, hook engine, host ops, and three runnable examples. Ported with `dsh-client-store` imports remapped to `dsh-client-runtime/client` and `session-controller`/`ui-session`/`remote-access` dev dependencies dropped.
- **`client-ui-claude-code-mods`** — the `ui.render` banner band. Same remaps; its `tsdown.config.ts` uses the fork `clientBundle(id, entries)` signature rather than the upstream `import.meta.dirname` form.
- **`token-meter` module-edge re-exports** — `export type *` lines for `usage-projection`/`breakdown-projection` restored so emitted `index.d.ts` references the projection modules carrying `SessionProjectionStateMap` augmentations; without them aggregate programs that import only the package root never see `contextPressure`.

Deferred, with the blocker that would have to land first:

- **`translator`, `client-ui-cot-translation`, `cot-translation-bundle`** — require `dsh-llm-deepseek-account`/`dsh-deepseek-account`, the account-provider surface the fork excludes by decision.
- **`session-inspector`, `inspector-profile`** — require `dsh-api-session-controller`'s `SessionEventSource`/`SessionBinding`/`MutableSessionEventSource`, a package the fork does not carry.
- **`inspector`, `webworker-runtime`, `webworker-packer`** — require `HostConnectionHandle.fetch`/`browserPeer`/`createSharedFetchHandler` and `TypertGateway.wireStream`, client-connection APIs absent here; `webworker-packer` additionally needs a `js-yaml` schema `.extend` shape the installed version lacks.

## Alternatives considered

- **Stub the missing seams** (a minimal `session-controller` or `HostConnectionHandle.fetch`) so the packages compile — rejected: it would fabricate capability surfaces no fork consumer drives, violating the current-owner rule.
- **Cut the account arm out of `translator`** to force the port — rejected: the `deepseek-account` discriminated-union arm is load-bearing; the rewrite belongs with the decision to introduce the account surface, not as an extraction shortcut.

## Consequences

`claude-code-mods` compiles as a host package; its `/remote` Typert surface emits through the host bundle pipeline, and `client-ui-claude-code-mods` typechecks once that artifact exists. The `directory-resume` spec still fails plugin resolution under hand-built `ctx.plugin(...)` mount and needs a REAL-composition repair. Upstream-sync bookkeeping records the five deferred packages so the next sync revisits them only if their blocking surfaces land.

## Verification

- `pnpm exec tsc -b packages/experimental/claude-code-mods` compiles clean, including the `contextPressure` projection augmentation.
- `npx vitest run packages/experimental/claude-code-mods/` — package specs pass except `directory-resume.spec.ts` (service-class mount under hand-built ctx; REAL-composition repair pending).
- `verify-translation-pairing` records all three new pairs; `verify-md-links` resolves the `hooks-claude-code` and subsystem-page targets after the `../../hooks/` path fix.
