# Agent Note: Permission catalog directory with generation-fenced reads

Status: implemented

English | [中文](2026-09-24-permission-catalog-mirror.zh.md)

## Problem

Every client surface that needs the host's permission preset catalog used to pull it independently, so concurrent consumers issued duplicate remote calls and a response that started before a host-side change could still install its stale result over a fresher read. Two deeper defects followed: a superseded response was still returned to the imperative picker caller, so an open menu could display options the host had already withdrawn, and a single shared mirror served every pooled runtime, so a session bound to a project runtime read the root connection's catalog instead of its own host's.

## Decision

[`PermissionCatalogDirectory`](../../../../packages/client/runtime/src/client/permission-catalog.ts) in the client runtime owns one `PermissionCatalogMirror` per pooled runtime connection, keyed by the resolved `ConnectionHandle`. `forSession(id)` returns a session-scoped face that resolves the owning runtime through `connection.forSession`, rebinds when session ownership republishes, and exposes the value snapshot, an invalidation channel, and the imperative `read()`. A face attaches to its mirror only while it has listeners, so idle sessions never pull.

Each mirror shares one in-flight pull per epoch: `read()` awaits the current pull and returns only a current-generation value — a response superseded by a newer invalidation is discarded rather than installed or returned. `subscribeInvalidations` publishes one tick per invalidation before the replacement read settles, so consumers holding displayed options withdraw them instead of trusting the retained value. The `permission-presets/catalog-changed` forward is attributed at each connection's frame sink through `invalidateFor(connection)`, and each mirror subscribes to its own connection's `hostDescription` — a retraction or replacement marks a generation boundary that clears the catalog before repulling, because the new generation may reach a different host whose catalog is unrelated. Disposal revokes write access so late settlements cannot resurrect a torn-down scope.

## Alternatives considered

**Let each consumer pull on demand.** Duplicate calls reappear, and there is no shared point where a stale response can be recognized.

**Cache with a time-to-live.** A TTL cannot distinguish "host catalog unchanged" from "connection moved to a different host", and expiry timing is unrelated to the actual invalidation events the host already publishes.

**Install every completed pull in arrival order.** The last response to land wins regardless of when it started, so an older catalog can overwrite a newer one — the exact defect epochs exist to reject.

**One process-wide catalog.** Correct only when every session shares one host; the pooled runtime topology gives each project runtime its own connection and therefore its own catalog.

## Consequences

Pickers and settings surfaces share one pull in flight per runtime per invalidation, and an imperative read that raced an invalidation settles on the replacement value instead of the stale response. Session-scoped faces keep the per-runtime routing honest even when a session is indexed after its consumers subscribed. The directory trusts the attributed `catalog-changed` forward and each connection's generation boundary as its complete invalidation set; a new invalidation source must call `invalidateFor` on the delivering connection rather than installing values directly.
