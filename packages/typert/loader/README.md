# @deepseek-ai/dsh-typert-loader

English | [中文](README.zh.md)

Node-only Loader integration for generated Typert artifacts. The plugin requires `ctx.loader` and `ctx.typert`; it does not provide the registry itself.

During activation it scans existing Loader entries. It then follows Cordis `internal/plugin` lifecycle notifications, resolves each entry package's `package.json`, imports `./typert` when exported, validates its `TYPERT` manifest, and registers the contribution until the entry or this plugin unmounts. An import that settles after either owner is gone is discarded.

`packages` lists additional package artifacts to register for plugins nested behind another Loader entry. Cordis fibers do not retain those nested plugins' npm specifiers, so this boundary is explicit; every configured package must resolve from the config tree and export `./typert`. Package-subpath entries are excluded from automatic discovery and rejected in `packages`. npm aliases validate artifacts against the manifest's package name, not the installed alias. Resolution follows the config tree's native Node lookup and materialized profile links.

Packages without the export are skipped. Package resolution and imported manifests are cached for the process lifetime, so adding an export requires a restart. A malformed artifact fails activation when already mounted; a later failure is logged without preventing unrelated packages from registering.

## Summary

With `dsh-typert-loader` mounted, every package that mounts in a Loader composition automatically contributes its generated Typert reflection and schema factories to the runtime registry — and withdraws them when the package or the plugin unmounts. Packages without the generated export are skipped, so adding the plugin to any composition is safe. An explicit `packages` list covers plugins nested behind another Loader entry, whose fibers carry no resolvable package specifier. It is a Node-only plugin and needs the config-tree resolution anchor to resolve packages.

## Invariants

**Runtime invariant:** No companion is published. The plugin registers generated contributions with `ctx.typert` at load; artifact data is owned by the registry.

## Model Experience

None, as loader integration only registers generated artifacts; consumers own any model-visible projection.

#### KV Cache effect

No direct effect; registration changes reach a request only through a consumer that reads the registry.

## Known Limitations and Deferred Work

- Discovery imports only the host face; client runtimes need a separate composition owner before equivalent discovery is added.
- Loader entries are discovered automatically. Nested or non-Loader plugins require an explicit `packages` entry or direct `ctx.typert.register()` ownership.
