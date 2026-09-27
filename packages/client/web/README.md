# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web boot kernel: `new AppWebEntry(el, seams?).run()` waits for any Host bootstrap readiness signal and mounts the client through two stages. The module stage calls the Host-installed `window.__ModuleLoader__.create()` with `window.__DSH_BOOT__`, the shell's static modules, and any test transport override; the facade returns the constructed module system and parsed manifest after adopting parser-preloaded registrations. This package then prefetches the `immediately` tier. The plugin stage mounts the vendored Cordis Loader, injects that module system through the Loader's `internal` interface, hands entry creation to the shared `ClientEntries` controller, and waits for every fiber to become ACTIVE. It then hands the marked boot DOM to the dynamic UI renderer's `ctx.uiRenderer.mount(el)` operation; the renderer hydrates that DOM before switching to the complete UI. The Host owns the graph, parser preloads, and facade; AppWebEntry does not know the bootstrap package id or parse the wire format.

The boot page uses plain DOM and local CSS, so client-bundle and plugin-activation failures remain visible. Its fallback fonts and colors match the theme tokens that arrive during loading. Fiber updates retain one spinner node and grow its CSS arc as entries first become active; hydration preserves that node and its animation phase until the application commit. React mounting, slot rendering, application assembly, and browser-title projection live in [`ui-renderer`](../ui-renderer/README.md). The modules bundle caches its own materialized exports and publishes its Loader’s module system when its ordinary graph entry activates; Cordis service waiting makes graph-row creation order independent from that activation.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shell-seeded shared modules. Together with `PRELOADED_CLIENT_EXTERNALS`, it defines the implicit external baseline for every dynamic bundle; `dsh.client.external` adds only exact non-baseline requests.

The optional override parameter `seams` forwards the module system's `loadBundle` transport override (`BootSeams`) for environments where external `<script>` execution cannot reach the page context; ordinary browser callers omit it.

Before prefetching or activating dynamic entries, the boot kernel installs compatibility implementations for missing `AbortSignal.any`, `AbortSignal.timeout`, and `AbortSignal.abort` factories. This keeps the browser client usable in Android WebViews that provide `AbortController` but not the newer static factories, while preserving native implementations when they exist.

The shell base styles apply automatic CJK/Latin spacing to ordinary content in supporting browsers. Code, terminal, diff, read, and search output retain literal source spacing and column alignment; engines without `text-autospace` support ignore the declarations.

`ClientEntries` owns both initial Loader entry creation and subsequent page-local graph reconciliation, retries, and rebuilt-code replacement. The Host emits bootstrap and application batches; `applyIndexInjections` executes the same structured table for an explicit page-owned carrier. CoHarness retains its runtime preload, static platform modules, authentication, and AbortSignal compatibility.

## Summary

`dsh-client-web` boots the web GUI: it loads the client module system from the Host-provided boot graph, then activates every client plugin before the application mounts, so the full UI appears only when every plugin is up. A framework-free boot page reports per-entry status, so a failing bundle or plugin stays visible instead of a blank screen. It also defines the shared module table (`PLATFORM_MODULES`) that every dynamic bundle resolves its externals against. The model never sees this package.

## Invariants

**Runtime invariant:** No companion is published. Boot is a one-shot module-load and plugin-mount sequence; a failed entry keeps the static boot page and there is no ongoing relation to observe.

## Model Experience

None, as the boot kernel is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The application waits for the full roster** — one failed entry keeps the framework-free boot page visible with a per-entry report; partial UI availability is not supported.
