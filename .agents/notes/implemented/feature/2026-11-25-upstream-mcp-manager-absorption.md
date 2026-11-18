# Agent Note: Upstream mcp-manager absorption

Status: implemented

English | [中文](2026-11-25-upstream-mcp-manager-absorption.zh.md)

## Problem

Upstream rc.3 ships `packages/mcp/mcp-manager` — a fleet supervisor that reconciles a volatile `servers` configuration map and plugin-registered MCP servers onto the mcp-client generation model, with `list`/`watch`/`restart`/`probe` management methods over Typert Remote. The local tree had no equivalent: configured MCP servers only existed as hand-wired `mcp-client` rows, with no live add/edit/enable/disable path, no aggregated status surface, and no client-reachable management namespace. The manager also depends on `packages/boot/config-editor` (atomic profile-patch writes), which the fork had previously rejected because its own settings pipeline owned configuration writes.

## Decision

Absorb the package as the new base and re-express its upstream-specific seams on local infrastructure.

`packages/mcp/mcp-manager` keeps the upstream lifecycle: `Config.servers` validates at composition load, on every `internal/config` waterfall re-resolve, and at plugin registration; entry changes reconcile per-server so a rebuild touches only the changed entry; removal or `enabled: false` unmounts the client and releases its tool namespace; cleanup failures are retained as `failed/cleanup` status records rather than thrown; stale callbacks after removal, replacement, or disposal are ignored through the generation identity; `probe` connects through a disposable instance that never disturbs the live one.

Local adaptations, in place of wholesale upstream code:

- **`internal/config` signature** — the vendored Cordis listener contract is `(config, next)` with `this` bound to the resolving Fiber, not upstream's `(fiber, next)`. The manager listener is a normal function comparing `this` to the owning Fiber; `next()` is still delegated before validation.
- **`config-editor` restored** — the rc.5 package is re-adopted because the manager's Settings-write path is exactly the atomic edit primitive it was deferred for. Its resolution flow uses local `fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)` plus `resolveConfig(fiber.runtime, resolved)` — upstream's `fiber.resolveConfig(next)` does not exist in the vendored Cordis — and `js-yaml` loads through a namespace import because the vendored v5 exposes no default callable.
- **`SettingsForms` replaced in tests** — upstream's settings form-facade service has no local counterpart, so `tests/profile-fixture.ts` carries a `settingsAdapter` over `ctx.configEditor` offering `describe`/`update`/`replace`/`mutate` with content-revision conflict checks. Local profile composition merges `servers` shallowly, so `mutate`'s unset path folds the inherited layer back into the patch to let an inherited entry reappear after a user override is removed.
- **Credentials fixtures** — the in-test provider implements the local `CredentialProvider` `*Owned` abstract surface (`resolveOwned`/`describeOwned`/`setOwned`/`unsetOwned`) rather than upstream's flat API.
- **Remote surface wired** — `packages/api/remotes/src/client/index.ts` mounts `mcpManagerRemote` and re-exports `McpManagedServerStatus`/`McpManagedServerView`; the web-app patch loads the manager after `credentials`. `/types` and `/remote` subpaths resolve through `tsconfig.base.json` paths for source-plane tests and package exports for built consumers.
- **Locales** — English and Chinese only, matching local convention; upstream's de/es/fr/ja/pt/ru files were not carried.
- **Upstream design note carried** — `2026-08-31-mcp-manager-plugin` (en/zh) was imported because the manager README references it; it records the upstream rationale this port inherits.

## Consequences

- `McpServerManager` is a `TypertRemoteService` contributing the `mcpManager` Remote namespace with `watch` (stream), `restart`, and `probe`; clients reach it through the api-remotes client assembly once `lib/typert.remote-client.js` is built.
- The web profile runs one fleet: Settings-visible edits to `servers` reconcile live, and any plugin may register an MCP server by name; configured names colliding with registrations are rejected.
- `packages/boot/config-editor` is back in the workspace (matrix record moved from `reject` to `adapt`) and is now the sanctioned path for atomic profile-patch edits.
- `tsconfig.host.json` gained both project references; `tsconfig.base.json` gained the `dsh-mcp-client/types` and `dsh-mcp-manager/types` subpath mappings the Typert analyzer needs to resolve cross-package type references in the manager's Remote surface.

## Alternatives considered

- **Skip the package until a settings UI exists** — rejected: the manager is host infrastructure; the Settings form consumer can arrive later while plugins and profile edits already reconcile, and the Remote namespace is the only client-reachable fleet view.
- **Vendor the manager without config-editor** — rejected: the Settings-write path is the package's tested persistence surface; stubbing it would have dropped the "malformed edit fails before persistence" guarantee the test suite proves.
- **Map upstream's `(fiber, next)` listener semantics onto local `(config, next)` transparently** — rejected: the two signatures cannot be told apart at runtime; adopting the local signature explicitly is the only correct option, and it is what config-editor already uses.

## Verification

- `pnpm exec vitest run packages/mcp/mcp-manager/tests` — 66 tests pass across `manager.spec.ts` and `composition.spec.ts`; the composition spec boots a real Loader profile and exercises settings-driven reconcile through `configEditor`.
- `pnpm exec tsc -b` for `packages/boot/config-editor`, `packages/mcp/mcp-manager`, and both `packages/api/remotes` faces — clean; the workspace `tsdown --env.DSH_BUILD_FACE host` pass emits `typert.host`/`typert.remote-client` artifacts for the new package.
- `verify-translation-pairing` — 2186 pairs consistent after recording the new READMEs and the carried design note; `verify-agent-note-format` — clean; `oxlint` on the touched packages — clean; `verify-cordis-config` reports only pre-existing fixture-declaration violations in `llm-deepseek`/`tool-pwsh` from the executor-seam batch.
