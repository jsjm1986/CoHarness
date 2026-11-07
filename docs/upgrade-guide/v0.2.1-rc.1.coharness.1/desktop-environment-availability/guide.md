---
kind: upgrade-guide
description: "Native Cua Driver desktop discovery and DesktopStatus unavailable replies require updated configuration and clients."
---

# Desktop environment availability

English | [中文](guide.zh.md)

## Change

Native and executable Cua Driver providers use `desktopMode: auto` by default. When no graphical session is detected, they publish an unavailable state and model guidance without starting the driver or its tools. Desktop-session evidence does not grant OS permissions or account access. External VNC targets and separately configured headless browsers remain independent.

`desktop.status` can return `{ unavailableReason: 'headless' | 'disabled' }` in addition to a confirmation or `null`. A confirmation refused for this reason reports `desktop-unavailable` with `details.reason`. The browser renders the limitation before offering consent.

Managed runtimes also load the read-only `gateway-execution/desktop-availability` plugin when no driver is configured. Launch readiness waits for its metadata, and `host.describe.computerUseUnavailableReason` lets matching clients explain the limitation during connection recovery. This metadata grants no desktop authority; a registered provider determines its own availability.

## Migration

1. Update the Gateway, Runtime and Web client together. Consumers of `DesktopStatus` handle the unavailable reply before reading confirmation fields. Verify that typed `host.describe` clients preserve the optional `computerUseUnavailableReason` field after decoding.
2. Keep `desktopMode: auto` for ordinary local desktops and headless servers. Set `disabled` to turn off this provider's desktop tools. For a prepared desktop outside session discovery, or an executable wrapper connected to a remote desktop, explicitly set `enabled`; existing OS and managed-user authorization still apply.
3. Open the selected computer's Admin deployment or desktop configuration. Confirm the desktop notice matches that computer, then check the user's desktop dialog. A headless server shows an explanation and no confirmation button; files, terminals and configured headless browsers remain available under their own permissions.
