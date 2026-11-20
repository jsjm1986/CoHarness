# Agent Note: Forge panel and remote-access port

Status: implemented

English | [中文](2026-11-15-forge-panel-remote-access-port.zh.md)

## Problem

The [forge lane absorption](../architecture/2026-11-15-forge-lane-absorption.md) carried the Host packages and deferred the browser face: `experimental/client-ui-forge`'s React half targets a different generation (upstream `*OutlineRegular` icons, upstream client-store and session-controller APIs, an upstream-only locales module, a `forgeWorktree` projection key with no local registration), and the panel's Host half reads `ctx.remoteAccess`, the generalized non-owner RBAC package the [authorize-seam decision](2026-10-17-remote-access-concepts-at-authorize-seam.md) had rejected for dispatch. Without both, the change-request workflow the lane landed has no UI.

## Decision

- Port `api/remote-access` where its contract is carrier-independent: `RemoteAccessService` keeps `registerPolicy`, `invalidate`, `decide`, `allows`, `snapshotFor`, `follow`, and the `REMOTE_ACCESS_SNAPSHOT_KEY` index injection on `webserver/index-inject`; the `/client` mount keeps the snapshot-store read face and publishes `useRemoteAccess` through `slots.provideRoot` `keyedHooks`. The dispatcher does not call `decide`: `typert-gateway/authorize` emits a `TypertGatewayAuthorizationRequest` that carries no principal, and `authorizeTypertRemote` with the collaboration authority stays the one authorization path, so the earlier decision's "no second authorization stack" rationale holds with `decide` shipped but uncalled.
- Port `experimental/client-ui-forge` Host and Client. The controller registers its own `forgeWorktree` projection through `sessionProjections.register()` — the local disposer idiom, not an upstream `ProjectionHandle` — and reads it through `stateOf(session, 'forgeWorktree')`; the client mounts through `ctx.slots.inject`/`register` on the local slot names; the Host face reads `remoteAccess` through `ctx.get` so a composition without the service degrades to unfiltered lists.
- Local substitutions inside the port: `*OutlineRegular` icons become the local `*16` names; upstream client-store/session-controller/session-list hooks become the client/runtime store and session APIs; upstream's `SettingsForm` primitive becomes a package-private `settings-form/` copied from the fork's settings-form pattern; upstream CSS-anchor Menu expectations become the local computed-fixed-position `Menu`; quote numbering keeps independent per-kind counters (`comment`/`thread`) that increment only after `conversation/append-input` accepts; `agent/pre-step` helpers omit the scoped `agent` field the local dispatcher injects; `Promise<SubprocessHandle>` call sites take the local subprocess contract.
- `experimental/forge-bundle` stays unported. No shipped composition may mount an experimental panel — release bundles cannot depend on experimental packages — and no opt-in preset composes the lane, so the upstream patch layer has no local consumer; the panel's coverage is its package suites.
- Only the `en` and `zh` locale catalogs are carried, matching every package in the fork.

The Client sources consume an `AsyncIterable` and cancel it through the signal supplied to the opener. The local Gateway returns plain async iterators, so teardown does not call an upstream-only `dispose` method on them. Source tests provide iterables without that method; the assembled browser scenario switches away from a Session with the Forge plugin mounted.

## Alternatives considered

- Wiring `decide` into `typert-gateway/authorize` was rejected: the authorization request carries no principal, so every call would evaluate as the owner and allow — a listener that can never deny is a second decision path with no decision. Re-entry: a carrier that mints non-owner principals names the call site.
- Porting `forge-bundle` was rejected: `bundle/web-app` cannot depend on experimental packages and no preset composes the lane; a bundle without a consumer adds a composition surface with zero coverage.
- Adding upstream CSS-anchor attributes to `Menu` and pointer-driven open to `Tooltip` was rejected: the local primitives own different contracts deliberately, so the copied tests were adapted to assert local behavior instead of growing anchor APIs for upstream expectations.
- The [earlier wholesale rejection](2026-10-17-remote-access-concepts-at-authorize-seam.md) of `api/remote-access` is narrowed, not reversed: the package lands for its policy registry, snapshot, and list-filtering surface while its dispatch role stays rejected.

## Consequences

- The panel is a loadable plugin: composed, it contributes the right-sidebar tabs and titles, the Session header utility, hero options, the input dock, shell overlay, session-row badges and hover cards, and worktree settings; nothing composes it yet, so product surface is unchanged until an opt-in lands.
- `remoteAccess` mounts standalone for policies, snapshots, and `allows` filtering; its Gateway-facing `decide` is exercised by the package suite and stays available for the carrier that introduces non-owner principals.
- `api/gateway`'s client gains `RemoteSnapshotStream` (byte-identical carry) for the baseline-and-delta follow protocol; `test-support/client-runtime` gains the static `access` face and `useRemoteAccess` becomes a `GlobalStandardProps` member the test runtime answers allow-all by default.
- The `/remote` src-plane stand-ins for `dsh-api-remote-access` and `dsh-experimental-client-ui-forge` join `vitest.shared.ts` `sourcePlaneAliases`, and the panel's test bench exposes a `stateOf` reader over the controller's own projection registration rather than a second handle.

## Verification

- `pnpm exec vitest run packages/api/remote-access/tests` — 40 tests pass (host policy/decide/snapshot matrix plus the client mount).
- `pnpm exec vitest run packages/experimental/client-ui-forge/tests` — 43 spec files, 1038 tests pass across the Host controller/review/states/git/worktree suites and the React client suites driven through the test runtime.
- `pnpm exec tsc -b packages/api/remote-access packages/experimental/client-ui-forge` — clean.
