# Agent Note: Remote-desktop stream URL binds the document runtime target through identity pinning

Status: implemented

English | [中文](2026-10-20-remote-desktop-stream-url-runtime-pinning.zh.md)

## Problem

`ClientRemoteDesktops.attach` built the WebSocket URL as `stream.path?token=`, carrying only the one-time token. The Gateway upgrade handler resolves the target runtime from the `dshTarget` query parameter or, failing that, the `hgw_scope` cookie — and the URL had neither. When the cookie disagreed with the scope the `attach` Remote call had been issued under (for example a project workspace entered without a scope switch), the upgrade was proxied to a runtime whose provider did not hold the pending attachment: `serveStream` destroyed the socket without consuming the token, the browser canvas stayed blank, and the orphaned pending attach expired sixty seconds later — the audit `detach` row lagging exactly one `attachTokenTtlMs` behind the `attach`.

## Decision

The attach response now passes the path through `connection.privateResourceUrl` before the protocol swap. That callback is the client-side binding of `BrowserIdentityFence.privateUrl`, which appends `dshTarget` (the document's pinned runtime) and `dshPrincipal` (the verified account id) to `/api/*` URLs — the same admission every other socket and private URL in the client already uses. The pinning must run on the http(s) form because the fence compares the candidate's origin with the page origin; a `wss://` URL would fail that check and return unpinned, so the URL is pinned first and only then converted to `ws(s)://`. The callback is optional: when no identity fence is present (standalone hosts, tests) the model falls back to the unpinned URL, keeping the previous behaviour rather than failing.

## Alternatives considered

**Read the scope cookie server-side and trust it.** Rejected: that is the broken path — the cookie tracks explicit scope switches, not the runtime a Remote call was routed to, and the two can disagree without any user action.

**Have the stream mount accept an attach-token lookup across runtimes.** Rejected: pending attachments are per-runtime state by design; fanning the lookup out would couple the providers and leak which tokens exist where, while the actual defect was the upgrade reaching the wrong runtime at all.

**Stamp `dshTarget` directly in the controller's `stream.path` response.** Rejected: the provider answers to all transports and does not know which runtime the requesting document resolves to; target pinning is the client document's concern, which is why the fence owns it.

## Verification

`packages/api/remote-desktop-controller/tests/client-model.client.spec.ts` covers both branches: a stand-in `privateResourceUrl` produces a `wss://` URL carrying `token`, `dshTarget`, and `dshPrincipal`; without the callback the URL keeps path and token only. The full package suite passes. A live reproduction showed the failure shape exactly: an upgrade scoped to `project:3` while the token was minted in the personal runtime closed with `1006` immediately, while the correctly scoped upgrade received the `RFB 003.889` banner from the real endpoint.

## Consequences

The upgrade now reaches the minting runtime regardless of the `hgw_scope` cookie, so a mismatched cookie can no longer strand the pending attach and blank the canvas. Any future socket opened by this model must pass through the same pinning call — bypassing it reintroduces the cookie dependency. `remote-desktop-controller`'s client `inject` now includes `connection`, which the web composition always provides; compositions without it still work through the `ctx.get` fallback.
