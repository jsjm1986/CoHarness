---
description: "View and control a remote machine's desktop from a right-sidebar tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-remote-desktop

English | [中文](README.zh.md)

## Summary

Open a `remoteDesktop` tab in the right sidebar for a granted remote node. The tab probes the endpoint, asks for an explicit consent gesture when the covering grant set changed, then opens the RFB screen over a one-time WebSocket token. View-level grants mount the screen read-only; control-level grants forward pointer and keyboard input.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this plugin in the Web profile; it registers the `remoteDesktop` sidebar tab kind. A caller opens a tab with `openTabIn(sessionId, 'remoteDesktop', { params: { nodeId, desktop? } })`.

The tab loads the endpoint status through `ctx.remoteDesktops`. When the caller's grant set is not yet consented, a card states the exact level — **View only** or **Control** — plus the recording flag when an administrator marks the grant for recording; **Confirm and connect** records the consent and attaches. When consent already covers the grants, the tab attaches directly. Denials surface the stable capability code as a localized notice with **Retry**. A live attachment shows the effective level and offers **Disconnect**; a closed stream offers **Reconnect**, which runs the status → attach flow again under the recorded consent.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

All authorization lives in the capability: the tab only performs `status → confirm → attach` over `ctx.remoteDesktops` (the remote-desktop controller's client half) and mounts the returned `ws(s)://` stream URL with the bundled `@novnc/novnc` `RFB` class. `viewOnly` mirrors the attached spec's level, but the VNC provider additionally filters client input messages inside the stream, so a forged control request still cannot inject input under a view grant. The guide entry lists only grants the caller may attach under in the current Session (`listGrants` with `attachable`), so session-scoped grants bound to other sessions never appear as targets. Grant, level, revoke, and audit administration live in the sibling `ui-remote-desktop-admin` settings section.

The `openScreen` callback is part of the injected face so tests mount the body without an RFB engine.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Remote-desktop capability](../../remote-desktop/remote-desktop/README.md)
- [VNC provider](../../remote-desktop/remote-desktop-vnc/README.md)
- [Remote-desktop administration](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-remote-desktop-admin) (README.zh.md in-repo)
- [Right sidebar](../../client/ui-sidebar-right/README.md)

**Runtime invariant:** No companion is published. Attach state and target lists come from `ctx.remoteDesktops` each render cycle; the plugin keeps no shadow of the capability's records.

<a id="model-experience"></a>
## Model Experience

None, as the desktop viewer and attach flow are human-operated surfaces — Agent computer use remains a separate seam — that register no model-visible content.

#### KV Cache effect

None; the plugin contributes no model request prefix.

## Known Limitations and Deferred Work

- The guide menu covers only grant-based target discovery; endpoints that exist but carry no grant for the caller never appear.
- The stream URL resolves against the page origin; deployments serving the RFB mount on another origin must extend `ClientRemoteDesktops.attach` instead of proxying at this layer.
- RFB recordings produced by the provider have no in-product playback surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
