# Agent Note: The center serves release-bundled web assets from its own release files

Status: implemented

English | [中文](2026-11-06-center-serves-release-assets.zh.md)

## Problem

Every `/assets/*` and `/plugins/*` request at the gateway was pinned to one Runtime — a `302` adding `?dshRuntime=<id>` derived from the Referer — and then proxied to the owning node, including remote nodes. Vite emits content-hashed filenames, so the bytes are identical on every computer running the same release, yet each Runtime's URLs keyed the browser cache separately and multi-megabyte bundles crossed the slowest link on the path. A browser working across several Runtimes re-downloaded the same immutable bundle once per Runtime.

## Decision

The center answers release-bundled static files from its own copy of the release instead of selecting a Runtime. [release-assets.ts](../../../../gateway/src/release-assets.ts) resolves the built frontend `dist` — `apps/web/dist` in workspace and managed-release layouts, or through the runtime entry's `dsh-web-app` → `dsh-web-frontend` dependency chain for pinned installs — the same files the Runtime's `frontend-static` serves. `ReleaseAssets.serve` answers a `GET`/`HEAD` for `/assets/*` and `/favicon.svg` when the decoded path stays inside the dist root and names a real file; anything else returns `false` and the request falls through to the existing Referer-pin and proxy path untouched.

The serve sits after authentication in [server.ts](../../../../gateway/src/server.ts) and before Runtime selection, so an unpinned URL, a `?dshRuntime=` URL, and a Referer-selected URL all read the center's bytes — the URL carries no Runtime identity, which is what lets one browser cache entry serve every Runtime. Access control is unchanged: the session gate still runs first and unauthenticated requests still get 401.

Cache semantics are per file. A basename carrying Vite's `-<8+ char hash>.<ext>` marker is content-addressed and gets `private, max-age=31536000, immutable`; any other file — `favicon.svg`, unhashed names — is served with no `cache-control`, matching the Runtime's `frontend-static` behavior for non-content-addressed files. `private` stays: bytes remain per-account, only the browser shares them across Runtime URLs, and no CDN or shared cache may store them. `br`/`gzip` variants mirror `packages/host/webserver`'s `precompressed.ts` (quality 9 / level 1, background-scheduled on first read, settled-entries-only with identity fallback, `vary: accept-encoding`) because the Runtime path compresses the same bytes and the center must not regress transfer size.

What stays runtime-scoped is everything not byte-identical across Runtimes. All `/plugins/*` keeps the existing path: combo bodies and `client.*.js` chunks are synthesized per Runtime composition, runtime-installed plugins have no release file to serve, and `/plugins/events` is a live HMR channel that must reach its owning Runtime. The Referer pin still redirects those URLs (`302` + `?dshRuntime=`), and shareable plugin URLs still forward silently under the Referer Runtime. A release-bundled name that is absent from the center's dist — including path-traversal attempts — takes the identical fallback.

## Alternatives considered

**Keep silent forwarding of shareable URLs under the Referer Runtime.** Rejected for `/assets/*`: it removed the visible redirect but still proxied immutable bytes through the owning node, so a remote Runtime's bundles kept crossing the slow link and local cache sharing depended on which Runtime served first. Serving from the center's own release files removes the hop entirely.

**De-runtime-ize `/plugins/*` the same way.** Deferred: chunk and combo bodies are synthesized by the Runtime's module registry from its own composition state, so reproducing the bytes at the center would need a second implementation of that pipeline. Content-hash revisions (also new) make it feasible later; the release-file-existence check used here cannot classify synthesized responses.

**`public` caching for the shared bundle.** Rejected: these are authenticated bytes and the task keeps the private posture — the win comes from dropping the Runtime identity from the URL, which already gives the browser one entry across Runtimes without opening the payload to shared caches.

## Consequences

A browser loading the same release on any number of Runtimes downloads each hashed bundle once, and no Runtime — local or remote — sits on the asset path. First-hit cost is one stat plus a read per file, with Brotli/gzip bodies built once per file generation on the libuv pool. Requests that miss the release dist (installed plugins, events, missing names, non-GET methods) are byte-for-byte on today's behavior. The fallback also bounds correctness: a deployment without a built frontend dist simply keeps Referer-pinned forwarding.

## Testing

`gateway/tests/release-assets.spec.ts` covers the routing decision end-to-end: hashed and nested assets served with `private` immutable caching and exact bytes, `favicon.svg` and unhashed names without cache headers, pinned and Referer-derived URLs answered without touching the catalog or proxy, missing files/traversal/`POST`/`/plugins/combo.js` falling through to the runtime path, `/plugins/events` still 302-pinning, and unauthenticated requests still 401. `node-service.spec.ts` keeps the pre-existing contract that shareable URLs forward to the Referer Runtime when the release-assets wiring is absent.
