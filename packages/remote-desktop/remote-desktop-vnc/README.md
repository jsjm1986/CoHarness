---
description: "VNC/RFB provider for ctx.remoteDesktop — JSONL-backed grant store, enforced resolve → attach → serveStream attachment flow, and an RFB pump that drops input frames on view-only attachments"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-desktop-vnc

English | [中文](README.zh.md)

**`VncRemoteDesktop`** implements `ctx.remoteDesktop` over the RFB protocol: it stores administrator grants in a JSONL file, enforces `resolve → attach → serveStream`, and pumps each upgraded socket to a configured VNC endpoint. A `view` attachment routes client→server bytes through `RfbClientFilter`, so key, pointer, and clipboard frames are dropped inside the provider.

## Summary

Install this provider when the harness serves human remote-desktop access to machines running a VNC server (macOS Screen Sharing, UltraVNC, KasmVNC, x11vnc). Administrators manage grants through the service's `grant`/`revoke`/`setLevel`; users attach through `attach` and open the returned stream path with a one-time token.

## Table of Contents

- [Configuration](#configuration)
- [Attachment flow](#attachment-flow)
- [View-only enforcement](#view-only-enforcement)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Field | Semantics |
|---|---|
| `endpoints` | `{ nodeId, desktop?, host, port }` rows; duplicate target keys fail at load. |
| `grantsFile` | JSONL grant-store path, rewritten atomically per mutation; `':memory:'` selects a volatile store. |
| `recordingDir` | Directory receiving `<sessionId>.rfb` raw stream captures for grants flagged `recording`; empty disables it and a flagged `serveStream` fails. |
| `attachTokenTtlMs` | Attach-token validity window; default `60000`. |
| `auditCapacity` | In-memory audit events retained for `audit()`; default `1024`. |
| `probeTimeoutMs` | `status` endpoint-probe timeout; default `3000`. |

<a id="attachment-flow"></a>
## Attachment flow

`attach` resolves grants, mints a one-time branded token, and returns `{ path, token }`. The API layer upgrades the client socket at `path` and calls `serveStream(token, socket)`; the provider consumes the token exactly once, dials the configured endpoint, and pumps until either side closes. `detach` and pump teardown share one commit path that records the `detach` audit event and emits `remote-desktop/attached`.

<a id="view-only-enforcement"></a>
## View-only enforcement

`RfbClientFilter` parses the client→server direction: the version preamble, security selection, authentication response, and `ClientInit` pass through, then framed messages are forwarded only for `SetPixelFormat`, `SetEncodings`, and `FramebufferUpdateRequest`. `KeyEvent`, `PointerEvent`, and `ClientCutText` are consumed and counted; unknown message types and unframeable security types fail closed by tearing the connection down.

<a id="model-experience"></a>
## Model Experience

No model-visible surface; nothing here enters prompts, tool schemas, or model results.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The view-only filter frames security types `None` and `VNC authentication`; other types (Tight, VeNCrypt, Apple DH) pass under `control` attachments but refuse `view` ones.
- Audit events are an in-memory ring; durable audit storage is the `remote-desktop-audit` follow-up.
- Recordings capture the raw RFB stream; playback/transcoding is out of scope.
- Endpoint reachability goes through the protected `dial` seam; routing it over the remote-session reverse tunnel is the integration follow-up.
- `':memory:'` grants are correct for tests and development; production deployments must set `grantsFile`.

<a id="dev-note"></a>
## Dev Note

The pump has no backpressure semantics beyond Node stream pause/resume; server→client traffic dominates and flows unfiltered by design. No `./invariant` companion ships — the store/pump relationships are exercised directly in `tests/`.
