# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

The shell owns one three-column AppFrame, resize geometry, and narrow-screen drawers. Its root declares `sidebar`, `conversation`, `rightbar`, the floating layer, and mobile header actions. The four-session Workbench remains the sole center conversation container; [ui-sidebar-right](../ui-sidebar-right/README.md) owns auxiliary tabs, splits, and visibility, while the frame consumes its presentation reports and allocates space. The theme presenter owns color scheme, alias tokens, content font size, and document metadata.

The frame publishes `data-viewport` and `--dsw-viewport-height` for narrow panes and on-screen keyboards. Medium mode keeps the navigation rail and overlays the auxiliary panel; compact mode uses a left drawer and fullscreen auxiliary panel. Scrim and Escape dismissal delegate to the tab owner instead of maintaining another visibility state. Closing the navigation drawer restores focus to its topbar control. Frame widths are transient; the sidebar owns Session-tab restoration.

The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, and the owner-share interfaces, including `MobileHeaderActionOwnerProps`. AppFrame, the panel store, and the concession solver remain package-internal.

`layout.openDetails(sessionId, target)` delegates a tool call to the sole auxiliary-panel owner; `target.callId` fixes the call independently of chat selection. `layout.focusRightbar(sessionId)` changes only the auxiliary target, preserving the center pane selection. The panel reports visibility, track reservation, and fullscreen presentation to the frame; collapsing it does not end a Host Session.

## Summary

This package provides the Web GUI's three-column AppFrame, edge-column widths, and `ctx.layout` presentation control. The right column concedes space before the center; its occupant renders fullscreen while the frame retains the wide-screen track underneath. The theme presenter owns color scheme, alias tokens, content font size, and document metadata. Layout state resets on reload.

## Invariants

**Runtime invariant:** No companion is published. Panel geometry and collapse are presentation-local service state; the frame's slot registrations prove disposal through the HMR-safety spec.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel widths are transient** — reload restores their defaults; the sidebar restores account-scoped Session tabs, visibility, and splits.
- **Insufficient space collapses the auxiliary panel** — the frame reports available room and the tab owner applies the collapse; a width preference does not imply visibility.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
