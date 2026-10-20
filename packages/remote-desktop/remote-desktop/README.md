---
description: "Remote-desktop capability seam (ctx.remoteDesktop) for the DeepSeek Harness — grant vocabulary (machine/session scope, view/control level), the RemoteDesktop service (resolve → attach), and the remote-desktop/* event vocabulary"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-desktop

English | [中文](README.zh.md)

The **`RemoteDesktop`** (`ctx.remoteDesktop`) is the human-facing capability for viewing and operating a remote node's desktop. It owns the grant vocabulary — durable machine-scoped and bounded session-scoped grants at `view` or `control` level — the enforced `resolve → attach` decision point, the `remote-desktop/*` event vocabulary, and the audit-event taxonomy. It does not own transports, endpoint resolution, or the browser client.

## Summary

Use `dsh-remote-desktop` when an application needs governed human access to remote desktops. Administrators issue grants through `grant`/`revoke`; a requesting human resolves an attachment spec against live grants and opens a session whose stream endpoint the browser client connects to. `view` access requires an explicit grant; `control` additionally requires the grant's level and is enforced inside the provider's stream so input events cannot be injected under a `view` attachment.

## Table of Contents

- [Service API (`ctx.remoteDesktop`)](#service-api-ctxremotedesktop)
- [The `remote-desktop/*` events](#the-remote-desktop-events)
- [Grant model](#grant-model)
- [Vocabulary](#vocabulary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service-api-ctxremotedesktop"></a>
## Service API (`ctx.remoteDesktop`)

A provider subclasses `RemoteDesktop` and implements eight members.

| Member | Semantics |
|---|---|
| `resolve(request, signal?)` | Match live grants for `{ target, principal?, sessionId? }`, compute the effective level (never exceeding the grants), and produce the enforced spec including the recording flag. Throws `RemoteDesktopError` with `REMOTE_DESKTOP_FORBIDDEN` when no live grant authorizes the request — resolution never silently narrows or widens. |
| `attach(request, signal?)` | Resolve, then establish the desktop transport and a stream endpoint; returns the `RemoteDesktopSession` owning `detach`. Implementations publish `remote-desktop/attached` only after the attach commits. |
| `status(target, signal?)` | Read live remote state of one desktop endpoint: reachability plus attachment count. |
| `listGrants(filter?, signal?)` | List grants; revoked rows require `includeRevoked`. |
| `grant(input, actor)` | Issue a grant; `actor.admin === true` required. Publishes `remote-desktop/grants-changed` only after the write commits. |
| `revoke(id, actor)` | Revoke a grant by id; returns the revoked row. |
| `audit(filter?, signal?)` | Query capability-owned audit events newest first, optionally restricted to a target or principal. |

<a id="the-remote-desktop-events"></a>
## The `remote-desktop/*` events

This package declares two emit events. `remote-desktop/grants-changed` fires after the grant set commits so admin views and cached authorizations refresh. `remote-desktop/attached` fires after an attachment opens or closes, carrying the session and a boolean direction.

<a id="grant-model"></a>
## Grant model

Two scopes coexist and are matched together at resolve time:

- **machine scope** — durable access to a node's desktop; no expiry.
- **session scope** — bounded access tied to a `SessionId` and a required `expiresAt`.

The effective level is the maximum level across matching live grants; a session grant can elevate but not silently downgrade a durable machine grant. `view` never defaults open — every access level requires a grant. The provider enforces the resolved level inside its stream path (a `view` attachment drops remote-input events), so UI visibility is never the enforcement point.

<a id="vocabulary"></a>
## Vocabulary

`RemoteDesktopGrantId` / `RemoteDesktopSessionId` / `RemoteDesktopToken` are branded opaque ids. `RemoteDesktopTarget` names a node plus an optional desktop identity (omitted selects the primary desktop). `RemoteDesktopSpec` is the resolved contract: target, effective level, authorizing grants, and recording flag. `RemoteDesktopSession` carries the branded session id, its spec, and the one-time stream endpoint (`path` + `token`) the browser client opens. `RemoteDesktopAuditEvent` is the closed taxonomy — `grant`, `revoke`, `set-level`, `attach`, `detach`, `level-escalate` — attributed to an explicit `RemoteDesktopActor`. Failures throw `RemoteDesktopError` carrying a stable `RemoteDesktopErrorCode` (`REMOTE_DESKTOP_FORBIDDEN`, `REMOTE_DESKTOP_TARGET_UNAVAILABLE`, `REMOTE_DESKTOP_GRANT_NOT_FOUND`, `REMOTE_DESKTOP_GRANT_EXPIRED`, `REMOTE_DESKTOP_STALE_TARGET`, `REMOTE_DESKTOP_TRANSPORT`). See `src/types.ts` for the full contracts.

<a id="model-experience"></a>
## Model Experience

No model-visible surface. This capability serves human users through the API and browser client; nothing in it enters prompts, tool schemas, or model results, so it has no token or KV-cache effect.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The audit-event taxonomy is defined here; durable audit storage lands with its provider (see `@deepseek-ai/dsh-remote-desktop-vnc`).
- Screen recording is a per-grant flag carried on the spec; the recording pipeline is provider behavior.

<a id="dev-note"></a>
## Dev Note

This package owns only the Service Definition — no provider implementation. It publishes no `./invariant` companion because it owns no observable runtime relationship; the provider package owns what it can check.
