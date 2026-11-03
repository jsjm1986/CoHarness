# Agent Note: HMR owns configuration watches before readiness

Status: implemented

English | [中文](2026-10-24-hmr-pending-watch-ownership.zh.md)

## Problem

The HMR configuration helper opened a Chokidar watcher and waited for readiness before registering its cleanup effect. Unloading HMR while readiness was pending could leave an allocated native directory watch outside the disposed provider. A later readiness callback would close it after effect registration failed, but no cleanup ran while readiness remained pending.

## Decision

Register watcher cleanup before awaiting readiness. Disposal settles the startup waiter, closes the watcher and joins its accepted refresh. A registration disposed during startup rejects rather than returning a usable disposer. Startup failure still closes its watcher; if closure also fails, an `AggregateError` preserves both causes. A queued close-time watcher error remains contained by the existing listener.

Canonical configuration-path reservations belong to the HMR service instance. The internal watcher helper keeps no process-wide registration map; its duplicate global map is removed. Public `watchConfig()` still rejects duplicate canonical paths and aliases through the existing instance registry.

## Consequences

Provider and root disposal own a configuration watcher even before its readiness event arrives. The watcher cannot remain active merely because that event is delayed. Successful registration, serial refresh behavior and the public disposer retain their existing semantics. This change concerns the HMR watcher, not general completion ordering for unrelated resources during enclosing-owner shutdown.

## Verification

A source test starts a real native Chokidar watch, withholds only delivery of its ready event, disposes the actual HMR context and checks that its watched-path map is empty before releasing readiness. The original implementation leaves the native paths registered. Existing cases cover canonical aliases, native events, missing parents, startup errors, self-removal and refresh settlement; a controlled close failure preserves the original startup failure.

The ordinary-Node built fixture performs provider-only disposal under the same readiness barrier and then loads a replacement HMR provider that registers the same path. It fails against the earlier built helper with native watched paths still present. The fixture restores exact prototype descriptors and closes its contexts, watchers and temporary directory on both outcomes. Native evidence here comes from the macOS host; CI owns the other platform runs.

## Alternatives considered

**Wait for readiness and rely on failed late effect registration.** That cleans up only after readiness arrives, leaving the watch active throughout an unbounded wait.

**Keep a second global path registry in the watcher helper.** The service already owns canonical reservations; module lifetime adds no necessary duplicate protection to the product entrypoint.

**Report only the final close error.** That hides the original startup failure and prevents callers from distinguishing acquisition failure from incomplete cleanup.
