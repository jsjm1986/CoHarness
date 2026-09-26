# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

English | [中文](README.zh.md)

Read-only **Plugin list** tab for Web Settings. The browser plugin registers one localized `settings.plugins.tab` contribution with id `all`; the Plugins section owns the navigation entry and tab chrome. It performs no Remote read during plugin activation. Selecting the tab for the first time mounts it and lazily calls `ctx.remote.pluginInventory.list()` through [`api-remotes`](../../api/remotes/README.md).

The tab renders a searchable two-column catalog of compact disclosure cards. Each collapsed card uses the short module name as its title and a small effective-enablement tag; enabled entries also show a colored root-fiber status dot. Expanding one card reveals its Loader-tree entry id without a redundant field label, followed by the effective configuration and, for enabled entries, Cordis status. Disabled entries omit the redundant unmounted runtime state. When the Host includes the Agent-preset projection, the tab separates preset rows from global rows, lets the user switch presets, marks conditional rows, and shows which presets provide a global entry; built-in preset names follow the active locale while user-authored names remain literal. The entry id remains the React key, disclosure identity, detail value, and an additional search target; it is never classified by string shape. Loading, empty, no-match, and generic failure states stay local to the mounted component, and a failed read can be retried without exposing transport details. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

Page synchronization status comes directly from `ClientEntries` through a framework-bound hook. A failed download or activation shows the affected plugin and a retry button; retry changes only this page, leaves Host enablement and the inventory search intact, and is disabled during synchronization.

## Summary

The **Plugin list** tab lets Web users inspect plugins without changing their configuration. It lists agent presets, then the global inventory; groups open on demand or during a search. Cards retain the package name as the primary title, identify instances by stable entry id, and expose enablement, source details, runtime status, disabled conditions, and discovery failures; preset-provided global entries name their presets. Search covers both groups and points to matches in other presets. The tab handles loading, empty, no-match, failure, and retry states without exposing transport details, and still shows the global inventory without a preset roster.

## Invariants

**Runtime invariant:** No companion is published. The tab renders one lazy `pluginInventory.list` Remote read on first mount; it owns no inventory state.

## Model Experience

None, as the package is a browser-side inventory projection that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per Settings mount or retry** — the tab does not subscribe to Loader changes or automatically refetch after reconnect; switching tabs preserves the current snapshot, while reopening Settings obtains a new one.
- **Read-only inventory** — the optional preset projection adds composition origin but Host plugin mutation remains unavailable from this tab.
