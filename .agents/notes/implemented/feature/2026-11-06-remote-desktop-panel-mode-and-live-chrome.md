# Agent Note: Remote-desktop tabs drive the panel display mode through their bound actions

Status: implemented

English | [中文](2026-11-06-remote-desktop-panel-mode-and-live-chrome.zh.md)

## Problem

An RFB stream is a live socket, not a view that can be re-rendered for free. Before this change the `remoteDesktop` sidebar tab behaved like an ordinary page: deselecting it unmounted the body, so every tab hop tore the stream down and the next visit re-attached — and re-answered any server credential challenge. The tab also had no way to use the panel's display mode: a remote desktop wants the whole frame, yet the surface's `push`/`fullscreen` switch sat only on the panel chrome, where an operator had to reach for it on every open. Finally, the stream could not be retuned without reconnecting — no zoom, no quality trade-off, no Ctrl+Alt+Delete.

## Decision

`SidebarRightTabActions` — the bound-action face every tab body already holds through `useTabInfo()` — carries `setPanelMode(mode: DockMode)`, the same `push`/`fullscreen` operation as the panel's chrome switch. The Tab domain forwards it to `SidebarRightController.setPanelModeIn(sessionId, mode)`, which applies the session's adopted store action and does nothing for a session whose store was never adopted. The surface-wide mode stays surface-owned: a body requests it for its own Session only, through the same routing that already made `tab.actions.openResource` land in its own pane. [Right Sidebar tab types and navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md) owns the action face and had left a display-mode operation off the navigation controller; this decision keeps that face unchanged and puts the operation on the tab's own actions instead.

The `remoteDesktop` kind declares `keepMounted`, so its visited body survives tab switches, Session changes, collapse, and docking without re-attaching. Once the stream is live and visible, the body calls `setPanelMode('fullscreen')` — once per mount, so an operator who exits fullscreen is not pulled back in until the body remounts — and the body's own chrome exposes the toggle in both directions. A live toolbar retunes the stream in place instead of reconnecting: **Fit**/**1:1** zoom maps to `scaleViewport` versus `clipViewport` plus `dragViewport` panning; three named quality presets map to Tight `qualityLevel`/`compressionLevel`; `resizeSession` asks ExtendedDesktopSize-capable servers to follow the container and is ignored by servers without the capability; **Ctrl+Alt+Del** appears under control grants; the level badge, recording flag, and **Disconnect**/**Reconnect** complete the chrome.

## Alternatives considered

**`setMode` on the `ctx.sidebarRight` navigation face.** The sidebar-tab-types decision already weighed a mode operation there and left it out: the face is control over the layout, and a mode call needs a captured target whose staleness the caller must manage. The tab-bound action needs no target — the occurrence carries its Session — and cannot act on a session it does not belong to.

**Re-attach on every visit instead of `keepMounted`.** Rejected: reconnecting pays a handshake and, on interactive endpoints, a fresh credential challenge for what is visually a tab switch. Retention costs memory for a canvas that may never be revisited, which `keepMounted`'s visited-only rule already bounds.

**A persistent auto-fullscreen preference.** Rejected: an operator who exits fullscreen has expressed the opposite intent for that viewing; re-applying on every visibility change would fight them. Asking once per body mount bounds the pull to the moment a stream actually arrives.

**A remote-desktop-specific slot for the toolbar.** Rejected: the chrome is content-level and needs no seat; the existing primitives (`SegmentedControl`, `Menu`, `Button`) compose it inside the body.

## Consequences

A public face every tab-body test fixture mocks gained a required member, and the remote-desktop tab keeps its stream — and any answered credential challenge — alive across tab hops. Retuning is local to the open stream: zoom and quality changes apply to the current RFB client and travel nowhere else. The once-per-mount fullscreen ask means a body remount — for example after the tab type is re-rendered — requests fullscreen again, accepting one extra request as the price of not persisting a preference. `setPanelMode` is deliberately absent from `ctx.sidebarRight`: layout control stays off the navigation face, and outside callers still cannot move the panel.

## Testing

`remote-desktop-body.client.spec.tsx` drives the body with a mocked screen and asserts the fullscreen request fires exactly once when the stream goes live, that the zoom and quality chrome retune the live screen, and that the Ctrl+Alt+Delete and fullscreen controls route to `sendCtrlAltDel` and `setPanelMode`.
