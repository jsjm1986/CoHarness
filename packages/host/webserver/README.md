---
description: "Web route-registration plugin: HTTP and upgrade routes, structured index injections, and static dist fallback; knows no harness concepts"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-webserver

English | [中文](README.zh.md)

Web HTTP and upgrade-route registration plugin (default-exported `WebServer`, config `{host, port, compression?, compressionLevel?, compressionThresholdBytes?}`): a `node:http` server that listens on activation and provides `ctx.webServer`. `register(route)` adds a named `exact`/`prefix` HTTP route; `registerUpgrade(route)` adds an upgrade route for an exact pathname. A duplicate path within either table throws because route patterns are a composition-level contract and a collision is a misconfiguration; both methods return a disposer that removes the registration. `registerFallback(handler)` registers the one handler for requests that match no named route. A second registration throws; the SPA dist server [`dsh-host-frontend-static`](../frontend-static/README.md) is the shipped owner, and the server returns 404 while none is registered. `tapIndex(transform)` adds an index.html transform, and `applyIndexTaps(html)` runs a body through the registered transforms in order; the fallback handler calls it on every index response. `renderIndexInjections()` appends a small `__DSH_BOOT_READY__` tail after structured rows; the served page resolves it immediately, while a preview bootstrap may settle the same deferred after its handshake. `AppWebEntry` awaits this optional signal before reading injected boot state. `port` reads the listening port (the OS-assigned value when `port` is 0), and `host` reads the configured bind host (composition-time facts other plugins adapt to, e.g. the directory-picker chooser). HTTP match order is fixed: exact over the whole table, then longest prefix, then the fallback handler. Upgrades match exactly and unmatched connections are closed; registration order carries no request-facing semantics.

`compression: 'gzip'` wraps socket-backed HTTP responses without changing route APIs. The client must prefer gzip and the media type must be compressible; known response lengths below `compressionThresholdBytes` stay identity, while unknown-length streams are eligible immediately. `compressionLevel` controls DEFLATE effort. Existing content encodings, `Cache-Control: no-transform`, range responses, SSE, ZIP, and the packaged `.gz` Worker image stay unmodified. The shipped Web bundle enables level 1 with a 1024-byte threshold; other compositions default to `compression: 'none'`. The Web Worker tunnel does not carry the browser-managed `Accept-Encoding` header, so its synthetic responses remain identity bytes.

The package knows no harness concepts and serves no files: the `/api` HTTP bridge and downlink WebSockets are routes owned by the connection plugin, plugin bundles and the HMR event stream are routes owned by the modules/hmr plugins, and dist serving belongs to the fallback owner. The upgrade handler owns the protocol handshake and connection contents; the webserver only delivers the raw socket and request. `host` takes one concrete IPv4 or IPv6 literal of a local interface — for example a container's own Pod address from `hostname -i`. A loopback literal (any address in 127/8, `::1`, or a mapped form of either) keeps the server on this machine; any other literal serves the network that address belongs to over plain HTTP, because this server carries no TLS. An unspecified address — including the IPv4-mapped forms Linux reads as IPv4 any — is rejected at load instead of opening the port on every interface at once. `port` 0 requests an OS-assigned port; `ctx.webServer.port` reads the listening port afterwards, and the exported `isLoopbackHost(host)` and `isWildcardHost(host)` classify an address by its parsed value, so a mapped or zoned spelling classifies as the address it names. A dotted-quad IPv6 tail names the address's own low 32 bits, exactly as `listen` reads it, so `::0.0.0.1` is loopback `::1` while `::127.0.0.1` is the non-loopback `::7f00:1`; `normalizeBindAddress(host)` returns that address text — `127.0.0.1` for a genuinely mapped `::ffff:127.0.0.1`, `::1` for `::0.0.0.1` and for `::1%lo` — ready to be a URL host. This server serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC bridge. This package never prints; the URL line belongs to the shell.

A listen failure (EADDRINUSE…) throws out of activation and rejects Loader composition with the bind diagnostic; the failed candidate fiber is disposed. An HTTP request whose handling throws (a fallback owner's `decodeURIComponent` on a malformed %-escape, a client dropping mid-body) is answered 400 — or the socket destroyed when headers are already out — and logged as a warning; it never exits the process. An upgrade-handler exception or upgraded-socket transport error is logged as a warning and destroys its socket. Disposal starts `close()` and `closeAllConnections()`, destroys every tracked upgraded socket, and returns only after the HTTP server and those sockets have closed.

A `script-preload` row adds an advisory classic-script preload to the head. Its URL is HTML-attribute escaped, and the row does not execute the script or settle boot readiness; ordered `script-src` rows and the readiness tail retain those responsibilities.

## Summary

Browsers reach the web GUI over HTTP through `dsh-host-webserver`: a `node:http` server where other plugins register named routes, upgrade routes, index startup inputs, and one fallback handler. It knows no harness concepts and serves no files — the `/api` bridge, plugin bundles, the HMR event stream, and the SPA dist belong to the plugins that register them. Route matching is fixed: exact over the whole table, then longest prefix, then the fallback handler. It serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC bridge.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as the HTTP carrier bridges browser and API handler and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No TLS, auth, or origin policy** — binding a non-loopback address exposes the server to that network; deployment hardening (or fronting it with a real reverse proxy) is deliberately out of scope for the dev-facing v1.
- **Socket options are fixed** — config selects the bind host and port, while backlog and other socket settings remain internal until a deployment needs them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
