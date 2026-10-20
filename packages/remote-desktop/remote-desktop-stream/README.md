---
description: "WebSocket mount for ctx.remoteDesktop — one upgrade route on ctx.webServer, the ?token= handshake, and the ws→Duplex adapter feeding serveStream"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-desktop-stream

English | [中文](README.zh.md)

**`remote-desktop-stream`** is the Web transport mount for `ctx.remoteDesktop`. It registers one exact-path upgrade route on `ctx.webServer` (`/remote-desktop/stream` by default), completes the WebSocket handshake, adapts the socket into a `Duplex`, and calls `RemoteDesktop.serveStream` with the one-time token carried in `?token=`.

## Summary

A browser client opens `wss://<host><stream.path>?token=<token>` after `remoteDesktop/attach`; the mount consumes nothing itself — `serveStream` validates and consumes the token exactly once, then pumps RFB with the resolved level enforced inside the stream. Text frames close the socket with status 1003; missing or invalid tokens destroy the connection. The token — minted per attach, single-use, TTL-bounded — is the stream credential; the route performs no separate authentication.

## Table of Contents

- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="composition"></a>
## Composition

Load alongside a `ctx.remoteDesktop` provider (`dsh-remote-desktop-vnc`) and `ctx.webServer`. The plugin uses `ctx.inject(['webServer', 'remoteDesktop'])` and activates only where both exist; the provider's `streamPath` config must match this plugin's so `attach` advertises the mounted path.

**Runtime invariant:** No companion is published. The mount owns only per-connection WebSocket plumbing; token and attachment truth stay in `ctx.remoteDesktop`.

<a id="model-experience"></a>
## Model Experience

None, as the transport mount relays a human's screen and input frames and adds no model input.

#### KV Cache effect

None; the mount contributes no model request prefix.

## Known Limitations and Deferred Work

- Origin policy and outer request rejection (`connection/request` waterfall) are the client-connection layer's job; this mount registers directly on `ctx.webServer`.
- Backpressure across the ws↔Duplex boundary is one-way: inbound `ws` messages do not pause the socket when the pump stalls (Node buffering applies); the outbound direction honors `send` callbacks.
- Recording disclosure to the connecting client is covered by the `confirm`/`status` consent flow, not by this socket.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
