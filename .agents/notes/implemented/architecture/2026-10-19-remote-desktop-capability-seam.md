# Agent Note: Remote-desktop capability seam

Status: implemented

English | [中文](2026-10-19-remote-desktop-capability-seam.zh.md)

## Problem

The harness needed governed human access to remote desktops — viewing and operating another machine's screen — without conflating it with the agent-facing computer-use surface. The decision points are authorization (who may view or control which desktop), enforcement (a view attachment must not inject input anywhere, including inside a protocol stream), and audit (administrative and attachment lifecycle must be reconstructable).

## Decision

A three-package capability seam owns the human desktop surface; nothing in it registers model-facing tools.

`dsh-remote-desktop` (`ctx.remoteDesktop`) is the Service Definition: the grant vocabulary (`view`/`control` levels; durable `machine` scope and bounded `session` scope carrying a required `expiresAt`), the enforced `resolve → attach → serveStream` flow, the `remote-desktop/*` event vocabulary, and the closed `RemoteDesktopAuditEvent` taxonomy. `resolve` is the single decision point — it matches live grants (unrevoked, principal-bound, target-bound, scope-valid) and throws `REMOTE_DESKTOP_FORBIDDEN` rather than silently widening or narrowing. Both scopes coexist; the effective level is the maximum across matching grants, so a session grant can elevate but never silently downgrade a durable machine grant. `view` never defaults open — every level requires a grant.

`dsh-remote-desktop-vnc` is the VNC/RFB provider: a JSONL grant store (atomic rewrite per mutation), configured endpoints per target, one-time attach tokens (consumed exactly once, TTL-bounded), and `pumpRfb` — where the level is enforced *inside the stream*. `RfbClientFilter` parses the deterministic client handshake (version, security selection, authentication response, ClientInit) so input cannot hide in an unframed preamble, then forwards only `SetPixelFormat`/`SetEncodings`/`FramebufferUpdateRequest` and consumes `KeyEvent`/`PointerEvent`/`ClientCutText` with a drop count; unknown message types and unframeable security types fail closed. `grant.recording` tees the server→client stream into `<sessionId>.rfb` captures under `recordingDir`.

`dsh-api-remote-desktop-controller` is the BFF: the `remoteDesktop/*` TypertRemoteService namespace. Every method authorizes the caller's session through the shared `userTerminalAuthorization` seam (identity = verified `creator`), maps administrator checks onto `userTerminalAdministration`, and delegates enforcement to the capability — service-side rejection holds even if a deployment miswires policies. `REMOTE_SESSION_POLICIES` declares each method's session path and read/write classification; attach is `execution: 'request'` (a human gesture starts remote execution).

## Consequences

- Audit events are an in-memory bounded ring on the provider; durable storage is the `remote-desktop-audit` follow-up.
- The `dial` seam accepts a replacement transport; remote-session reverse-tunnel routing is the integration follow-up.
- View-only framing supports security types `None` and `VNC authentication`; other types refuse view attachments (control passes through).
- The browser client packages (`ui-remote-desktop`, `ui-remote-desktop-admin`) and the WebSocket mount for `stream.path` are the next increment.

## Alternatives considered

**Grant model inside the controller.** BFF-local authorization would duplicate enforcement per consumer; the grant model is capability vocabulary.

**Filter at the client UI.** Hiding input controls cannot stop a crafted stream; the drop must happen inside the provider's pump.

**A second authorization seam.** A `remoteDesktopAuthorization` face would force deployments to implement the same human-gesture policy twice; the terminal seam already answers "which authenticated human is on this session."
