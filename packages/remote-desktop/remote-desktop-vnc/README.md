---
description: "VNC/RFB provider for ctx.remoteDesktop — JSONL grant store, consent-covered resolve → confirm → attach → serveStream flow, append-only audit log, and an RFB pump that drops input frames on view-only attachments"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-desktop-vnc

English | [中文](README.zh.md)

**`VncRemoteDesktop`** implements `ctx.remoteDesktop` over the RFB protocol: it stores administrator grants in a JSONL file, enforces `resolve → attach → serveStream`, and pumps each upgraded socket to a configured VNC endpoint. A `view` attachment routes client→server bytes through `RfbClientFilter`, so key, pointer, and clipboard frames are dropped inside the provider.

## Summary

Install this provider when the harness serves human remote-desktop access to machines running a VNC server (macOS Screen Sharing, UltraVNC, KasmVNC, x11vnc). Administrators manage grants through the service's `grant`/`revoke`/`setLevel`; users `confirm` once per grant set, then `attach` and open the returned stream path with a one-time token.

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
| `endpointsFile` | `{endpoints: [...]}` JSON maintained by the deployment's administration surface; replaces the inline list and reloads on change. A malformed write keeps failing loudly on each call until a valid file lands. |
| `grantsFile` | JSONL grant-store path, rewritten atomically per mutation and reloaded when an external writer replaces it; `':memory:'` selects a volatile store. A malformed line fails loudly while the last good rows stay in effect. |
| `recordingDir` | Directory receiving `<sessionId>.rfb` raw stream captures for grants flagged `recording`; empty disables it and a flagged `serveStream` fails. |
| `streamPath` | Pathname the stream mount serves; clients append `?token=`; default `/remote-desktop/stream`. |
| `attachTokenTtlMs` | Attach-token validity window; default `60000`. |
| `auditFile` | Append-only JSONL audit path; `':memory:'` selects a volatile window. |
| `auditCapacity` | Audit events retained for `audit()` queries and reloaded from the file tail; default `1024`. |
| `probeTimeoutMs` | `status` endpoint-probe timeout; default `3000`. |

<a id="attachment-flow"></a>
## Attachment flow

`confirm` resolves the caller's grants, records consent covering the resolved grant set at the requested level (a `consent` audit event), and returns the spec so the caller learns its recording flag. `attach` then resolves again, requires a covering consent (`REMOTE_DESKTOP_CONSENT_REQUIRED` otherwise — a new grant in the set, a level raise, or a restart all demand a fresh `confirm`), mints a one-time branded token, and returns `{ path, token }`. The transport mount upgrades the client socket at `path` and calls `serveStream(token, socket)`; the provider consumes the token exactly once, dials the configured endpoint, and pumps until either side closes. `detach` and pump teardown share one commit path that records the `detach` audit event and emits `remote-desktop/attached`. A consumed token's session also detaches on any pre-pump failure — a missing endpoint, an unreachable dial, a recorder that cannot open — and an unconsumed token expires into the same detach path after `attachTokenTtlMs`. `revoke` and `setLevel` re-evaluate every live session against the remaining grants: a session whose resolved level is no longer authorized is detached and audited.

<a id="view-only-enforcement"></a>
## View-only enforcement

`RfbClientFilter` parses the client→server direction: the version preamble, security selection, authentication response, and `ClientInit` pass through, then framed messages are forwarded only for `SetPixelFormat`, `SetEncodings`, and `FramebufferUpdateRequest`. `KeyEvent`, `PointerEvent`, and `ClientCutText` are consumed and counted; unknown message types and unframeable security types fail closed by tearing the connection down.

<a id="model-experience"></a>
## Model Experience

No model-visible surface; nothing here enters prompts, tool schemas, or model results.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The view-only filter frames security types `None` and `VNC authentication`; other types (Tight, VeNCrypt, Apple DH) pass under `control` attachments but refuse `view` ones.
- Consents are in-memory: a restart requires one fresh `confirm` per grant set; `auditFile` makes the audit trail itself durable.
- Recordings capture the raw RFB stream; playback/transcoding is out of scope.
- Endpoint reachability goes through the protected `dial` seam; routing it over the remote-session reverse tunnel is the integration follow-up.
- `':memory:'` grants are correct for tests and development; production deployments must set `grantsFile`.

<a id="dev-note"></a>
## Dev Note

The pump has no backpressure semantics beyond Node stream pause/resume; server→client traffic dominates and flows unfiltered by design. No `./invariant` companion ships — the store/pump relationships are exercised directly in `tests/`.
