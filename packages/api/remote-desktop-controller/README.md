---
description: "Browser-facing BFF controller for ctx.remoteDesktop — remoteDesktop/* Remote namespace mapping authenticated human authority onto grant administration, attach, status, and audit"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-remote-desktop-controller

English | [中文](README.zh.md)

**`RemoteDesktopController`** (`ctx.remoteDesktopController`, Remote namespace `remoteDesktop`) is the BFF between the browser and `ctx.remoteDesktop`. Every method resolves the caller's actor from the request's verified principal, delegates grant enforcement to the capability, and never accepts a caller-supplied actor.

## Summary

The controller exposes `status`, `attach`, `listGrants`, `grant`, `setLevel`, `revoke`, and `audit` over the Remote transport. Session-scoped calls (`status`, `attach`) bind the addressed session for grant matching and take the principal from the verified request claims; management calls additionally require the administrator role. In standalone deployments the local operator holds both roles.

## Table of Contents

- [Methods](#methods)
- [Authorization](#authorization)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="methods"></a>
## Methods

| Method | Session scope | Role | Semantics |
|---|---|---|---|
| `status(agent, target)` | caller's session | any grant holder | Endpoint availability, attachment count, and the caller's grant summary (`level`/`recording`/`consented`). |
| `confirm(agent, target, level)` | caller's session | matching grant | Records consent covering the resolved grant set; returns the spec acknowledged (including `recording`). |
| `attach(agent, target, level)` | caller's session | matching grant + covering consent | Returns `{ id, spec, stream }`; fails `remote-desktop/failure` `REMOTE_DESKTOP_CONSENT_REQUIRED` without a prior `confirm`. |
| `listGrants(agent, filter)` | caller's session | admin sees all; others own principal | Grant rows, optionally including revoked; `attachable` restricts to grants attachable from the caller's session. |
| `grant(agent, input)` | administrator's session | admin | Issues a grant attributed to the caller. |
| `setLevel(agent, grantId, level)` | administrator's session | admin | Changes a grant's level. |
| `revoke(agent, grantId)` | administrator's session | admin | Revokes a grant. |
| `audit(agent, filter)` | caller's session | admin sees all; others own principal | Audit events, newest first. |

<a id="authorization"></a>
## Authorization

`RemoteDesktopAccess` reads the request's verified Gateway principal through `gatewayRuntime.interactive()` in managed deployments (execution-authority present): `principal` is the claim's username and `admin` its role, so administrator-issued grants are the whole product permission — no user-terminal grant is required. Restricted-purpose and non-interactive callers are denied with `remote-desktop/forbidden`; standalone deployments fall back to a `local-operator` administrator. Service-side enforcement still applies — admin methods reject non-admin actors even if a deployment miswires the policies.

<a id="client-half"></a>
## Client half

`@deepseek-ai/dsh-api-remote-desktop-controller/client` installs `ctx.remoteDesktops` (`ClientRemoteDesktops`): it self-mounts the generated `remoteDesktop` Remote contribution (`./remote`), converts each `{ ok }` wire result into thrown errors, and resolves `attach`'s `{ path, token }` to an absolute `ws(s)://` URL against `location`, pinned through `connection.privateResourceUrl` (`dshTarget`/`dshPrincipal`) so the Gateway upgrade reaches the runtime that minted the token — the scope cookie alone is not reliable for that. UI plugins (`ui-remote-desktop`, `ui-remote-desktop-admin`) consume this service rather than the wire namespace directly.

**Runtime invariant:** No companion is published. Grant, attachment, and audit truth live in `ctx.remoteDesktop`; the controller is a stateless request translator with no diverging observation of its own.

<a id="model-experience"></a>
## Model Experience

None, as the BFF namespace serves human operators and no method result enters a model request.

#### KV Cache effect

None; the namespace contributes no model request prefix.

## Known Limitations and Deferred Work

- `serveStream` is exposed by the capability, not this namespace; `dsh-remote-desktop-stream` mounts the WebSocket path (`stream.path` + `?token=`).
- Capability rejections surface as `remote-desktop/failure` with the stable `RemoteDesktopErrorCode` in `code`; `remote-desktop/forbidden` remains the wire code for controller-side interactive-user and administrator checks.
- Detach is implicit (stream close); an explicit force-detach admin method is deferred.
- Session-scoped grants use the caller's session for grant matching at attach; granting on behalf of a different session happens through the `scope.sessionId` payload under administrator authority.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
