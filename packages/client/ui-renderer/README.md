# @deepseek-ai/dsh-client-ui-renderer

English | [中文](README.zh.md)

The browser Cordis plugin that owns the React rendering layer. [`dsh-client-web`](../web/README.md) renders a framework-free boot page and loads the complete client plugin roster; after every entry activates, it calls `ctx.uiRenderer.mount(container)`. This package provides that service, installs the slot renderer, hydrates the existing boot DOM, switches to the assembled application before the next paint, and returns the React root's unmount disposer.

The client entry also owns the React implementation of slot outlets, session providers, and observable-to-uSES binding. Business plugins pass bare observable sources through typed slot `hooks`; the renderer binds them at the outlet. `SessionProvider` follows the current selection when no id is supplied and can bind one explicit listed Session for a multi-pane surface. The plugin activates after `slots`, `sessions`, and `layout`, projects the selected session title, and performs the sole context-level `renderSlot('root')` call. React, React DOM, Cordis, ui-slots, and ui-primitives retain one browser identity through the web shell's static module table; this package arrives as a dynamic client bundle.

## Summary

`dsh-client-ui-renderer` mounts the assembled dsh web client GUI: after the complete client plugin roster settles, the boot kernel calls `ctx.uiRenderer.mount(container)`, which hydrates the framework-free boot page and switches to the full React application before the next paint. Business plugins stay plain React components that receive session and workspace data through typed props and never wire subscriptions themselves — the renderer binds the runtime's bare observable sources into selector hooks at the slot outlets. The web shell and the boot kernel are its only direct consumers, so a composition needs it exactly when it wants a React-rendered GUI.

## Model Experience

None, as the package is a browser-side render assembly that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The first application frame waits for every client entry** — the boot kernel hands over the mount point only after the loader roster settles. Per-region readiness remains deferred.
- **Slot rendering has no Suspense integration or per-entry lazy loading** — the complete plugin roster settles before the renderer mounts the root.
