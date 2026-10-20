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

-----

<a id="use-this-package"></a>
## Use this package

Compose this plugin in the Web profile; it registers the `remoteDesktop` sidebar tab kind. A caller opens a tab with `openTabIn(sessionId, 'remoteDesktop', { params: { nodeId, desktop? } })`.

The tab loads the endpoint status through `ctx.remoteDesktops`. When the caller's grant set is not yet consented, a card states the exact level — **View only** or **Control** — plus the recording flag when an administrator marks the grant for recording; **Confirm and connect** records the consent and attaches. When consent already covers the grants, the tab attaches directly. Denials surface the stable capability code as a localized notice with **Retry**.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

All authorization lives in the capability: the tab only performs `status → confirm → attach` over `ctx.remoteDesktops` (the remote-desktop controller's client half) and mounts the returned `ws(s)://` stream URL with the bundled `@novnc/novnc` `RFB` class. `viewOnly` mirrors the attached spec's level, but the VNC provider additionally filters client input messages inside the stream, so a forged control request still cannot inject input under a view grant. Grant, level, revoke, and audit administration live in the sibling `ui-remote-desktop-admin` settings section.

The `openScreen` callback is part of the injected face so tests mount the body without an RFB engine.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Remote-desktop capability](../../remote-desktop/remote-desktop/README.md)
- [VNC provider](../../remote-desktop/remote-desktop-vnc/README.md)
- [Remote-desktop administration](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-remote-desktop-admin) (README.zh.md in-repo)
- [Right sidebar](../../client/ui-sidebar-right/README.md)

<a id="model-experience"></a>
## Model Experience

This package is a human-facing Client UI; it contributes nothing to prompts, tools, or the model context, and the remote desktop it exposes is explicitly for a human operator — Agent computer use remains a separate seam.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Tabs open programmatically with a `nodeId` parameter; no in-product target browser exists yet — deployments or companion plugins own endpoint discovery.
- The stream URL resolves against the page origin; deployments serving the RFB mount on another origin must extend `ClientRemoteDesktops.attach` instead of proxying at this layer.
- RFB recordings produced by the provider have no in-product playback surface.
