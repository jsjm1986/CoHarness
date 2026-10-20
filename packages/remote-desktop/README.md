---
description: "The remote-desktop stack: a human-facing capability seam (grant model, enforced resolve → attach, audit taxonomy), a VNC/RFB provider with view-only input filtering, and the browser-facing BFF controller namespace."
kind: "package-group"
---

# remote-desktop/ - human remote-desktop family

English | [中文](README.zh.md)

The remote-desktop stack lets an authenticated human view and operate a remote node's desktop: a grant vocabulary (durable machine scope and bounded session scope at `view`/`control` level), the enforced `resolve → attach → serveStream` decision point, an RFB provider that drops input frames under view-only attachments, and the `remoteDesktop/*` BFF namespace. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `remote-desktop/` | Service Definition: grant model and scopes, the `RemoteDesktop` service (`resolve → attach → serveStream`), and the `remote-desktop/*` event/audit vocabulary | `ctx.remoteDesktop` |
| `remote-desktop-vnc/` | VNC/RFB provider: JSONL grant store, endpoint dialing, consent-covered token attach, the view-only `RfbClientFilter` inside the pump, and the append-only audit log | (registers `ctx.remoteDesktop`) |
| `remote-desktop-stream/` | Web transport mount: one WebSocket upgrade route on `ctx.webServer`, the `?token=` handshake, and the ws→Duplex adapter feeding `serveStream` | (mounts `ctx.remoteDesktop`) |
| `api/remote-desktop-controller/` | BFF controller: the `remoteDesktop/*` Remote namespace mapping authenticated human authority onto service calls | `ctx.remoteDesktopController` |

The Service Definition lives at `remote-desktop/remote-desktop/`. A different transport (RDP, WebRTC) can replace `remote-desktop-vnc` without touching the grant model or the controller: level enforcement lives inside the provider's stream path, so a replacement must carry the same guarantee (a `view` attachment cannot inject input). Access never defaults open — every level requires an administrator grant, and session-scoped grants always carry an expiry.

## Summary

The `remote-desktop/` group gives the harness governed human desktop access: `ctx.remoteDesktop` defines grants and the enforced attachment contract in `remote-desktop/`; `remote-desktop-vnc/` implements it over RFB against configured VNC endpoints (macOS Screen Sharing, UltraVNC, KasmVNC/x11vnc); `api/remote-desktop-controller/` exposes `status`/`attach`/`listGrants`/`grant`/`setLevel`/`revoke`/`audit` to the browser under authenticated-session authority plus administrator checks. Audit events record grant lifecycle, attach/detach, and level escalation; recording is a per-grant flag captured by the provider.

- [Remote-desktop subsystem](../../docs/subsystems/remote-desktop.md) — the grant model, enforced `resolve → attach` contract, stream sessions, and audit taxonomy.
