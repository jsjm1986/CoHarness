# Agent Note: Gate the open-in-app action on base-runtime session ownership

Status: implemented

English | [中文](2026-10-04-open-in-app-local-runtime-gate.zh.md)

## Problem

`OpenInAppAction` rendered the local application opener for any session whose summary carried a `cwd`. Once the session pool merged rows from every established runtime, a session owned by a foreign runtime still showed the action; launching it POSTed the foreign path to the page host's `open-in-app/open` route, which resolves paths against this host's filesystem and app catalog.

## Decision

Host-local actions resolve runtime ownership before offering themselves. The injected action face carries `localTarget(sessionId)`; the production injection returns true only when `ctx.sessions.runtimeTargetFor(sessionId)` resolves to `{ kind: 'base' }` (absent resolver defaults to base, matching the single-runtime build). The render guard treats a non-base target like a missing catalog entry and returns `null`, so no split button and no launch request can reach the local route for a foreign session.

## Files

- `packages/client/ui-open-in-app/src/client/OpenInAppAction.tsx` — `localTarget` on `OpenInAppActionInjected`; render guard on the resolved target.
- `packages/client/ui-open-in-app/src/client/index.ts` — production injection via `ctx.sessions.runtimeTargetFor`.
- `packages/client/ui-open-in-app/tests/open-in-app-action.client.spec.tsx` — foreign-target fixture renders nothing.

## Consequences

A remote session's `cwd` can no longer reach the page host's opener. The same gate pattern applies to any future action whose target route or catalog lives on the page host rather than the session's owning runtime: check `runtimeTargetFor` (or the equivalent ownership projection) before rendering, not just whether display fields happen to be populated.
