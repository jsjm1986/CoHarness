# Agent Note: Experimental inspector port through fork seams

Status: implemented

English | [中文](2026-10-18-experimental-inspector-port.zh.md)

## Problem

Upstream rc.2 ships an experimental developer-tools group — the DevTools `inspector` (`captureFetch`, Console evaluation, Sources, Elements trees, CDP-independent query API), the `session-inspector` (virtualized raw Session log and Chat group/node tables with streamed delta rows), and the `inspector-profile` opt-in bundle — that the fork had deferred because it "requires the excluded api/session-controller surface". The plugin-manager showcase lists `inspector-profile`, so the row needed real content.

## Decision

All three packages are ported into `packages/experimental/` under upstream names with upstream's bilingual `locale/*.json` and `icon.svg` verbatim. The session-controller dependency mapped onto the fork's own surfaces: `packages/client/runtime` owns session/event state on the browser side and `packages/api/remotes` + `packages/api/gateway` own the wire — the deferred blocker was a name mismatch, not a missing seam.

`inspector` keeps Host and Client compiler faces (`tsconfig.host.json`/`tsconfig.client.json` references); `session-inspector` and `inspector-profile` are Host-face packages. `inspector-profile` is registered in `OPTIONAL_BUNDLES` so the plugin-manager showcase toggles it, and in `apps/cli` dependencies; none enters a shipped default composition.

## Alternatives considered

- **Keeping the defer** was rejected: the owner's directive is to sync all upstream plugin functionality, and the mapped seams cover the dependency.
- **Fork-side session-controller clone** was rejected: remapping reads to `client/runtime` and `api/remotes` preserves the fork's data-plane ownership instead of adding a parallel API surface.

## Testing

Per-package specs ported with the sources (`inspector` 37 spec files, `session-inspector` 28, `inspector-profile` patch spec); `tsc --noEmit` clean on all three faces. Verification log: `.rc2-work/logs/inspector-port.log` work continued after the original porting agent was interrupted; registration completed directly.

## Consequences

The developer-tools group lands as opt-in experimental packages, so release compositions stay unchanged while the inspector surfaces can be toggled through the plugin-manager showcase. Session and wire reads go through the fork's own `client/runtime` and `api/remotes` seams — no parallel controller surface was introduced.
