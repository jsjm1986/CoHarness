---
description: "Web boot kernel: static module table, Cordis loader, framework-free boot page, and UI-renderer handoff"
kind: "package-library"
---

# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

The Web boot kernel waits for any Host bootstrap readiness signal and mounts the client through `new AppWebEntry(el, seams?).run()`. The Host's `window.__ModuleLoader__.create()` accepts `window.__DSH_BOOT__`, the shell's static modules, and any test transport override. It adopts parser-preloaded registrations and returns the module system and parsed manifest. The kernel prefetches required `immediately` entries, installs the module system as the Cordis Loader's `internal`, and lets `ClientEntries` activate the required roster. It hands the marked boot DOM to `ctx.uiRenderer.mount(el)` after all required fibers activate. The renderer hydrates that DOM before rendering the application. A later browser task releases optional entries through the same controller. The Host owns the graph, parser preloads, and facade.

The boot page uses plain DOM and local CSS, so client-bundle and plugin-activation failures remain visible. Its fallback fonts and colors match the theme tokens that arrive during loading. Fiber updates retain one spinner node and grow its CSS arc as entries first become active; hydration preserves that node and its animation phase until the application commit. React mounting, slot rendering, application assembly, and browser-title projection live in [`ui-renderer`](../ui-renderer/README.md). The modules bundle caches its own materialized exports and publishes its Loader’s module system when its ordinary graph entry activates; Cordis service waiting makes graph-row creation order independent from that activation.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shell-seeded shared modules. Together with `PRELOADED_CLIENT_EXTERNALS`, it defines the implicit external baseline for every dynamic bundle; `dsh.client.external` adds only exact non-baseline requests.

The optional override parameter `seams` forwards the module system's `loadBundle` transport override (`BootSeams`) for environments where external `<script>` execution cannot reach the page context; ordinary browser callers omit it.

Before prefetching or activating dynamic entries, the boot kernel installs compatibility implementations for missing `AbortSignal.any`, `AbortSignal.timeout`, and `AbortSignal.abort` factories. This keeps the browser client usable in Android WebViews that provide `AbortController` but not the newer static factories, while preserving native implementations when they exist.

The shell base styles apply automatic CJK/Latin spacing to ordinary content in supporting browsers. Code, terminal, diff, read, and search output retain literal source spacing and column alignment; engines without `text-autospace` support ignore the declarations. Boot failure reports wrap long paths and scroll within the viewport. The loading indicator retains a slow rotation under reduced motion and uses system colors in forced-colors mode, independently of theme loading.

`ClientEntries` owns both initial Loader entry creation and subsequent page-local graph reconciliation, retries, and rebuilt-code replacement. The Host emits bootstrap and application batches; `applyIndexInjections` executes the same structured table for an explicit page-owned carrier. CoHarness retains its runtime preload, static platform modules, authentication, and AbortSignal compatibility.

The primary Gateway can render the release shell for an authenticated remote Runtime before contacting that computer. The frontend's `@deepseek-ai/dsh-client-web/boot` entry shows tab-local, unsent input while it loads the renderer's shared modules and reads the Runtime's authenticated index rows. While the shell is waiting, its full-workspace link opens the same account and Runtime in a new tab and leaves the draft in the original tab. The deferred entry loads the bootstrap scripts before requesting application plugin bundles. A failed same-origin, revision-pinned bootstrap download receives one retry at the same URL. The normal renderer waits for required plugin activation. The browser transfers the text only when the exact saved Session and Gateway account qualify for a draft writer. When a saved Session cannot qualify or a native index transform requires the full document, the original document keeps the text available to copy.

## Summary

`dsh-client-web` boots the web GUI from the Host-provided graph. A framework-free page reports required entry activation. Optional plugins load after the renderer mounts, and their errors appear in the sidebar Plugins page. Dynamic bundles resolve shared dependencies against `PLATFORM_MODULES`. The model never sees this package.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as the boot kernel is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- A failed required entry keeps the framework-free boot page visible with a per-entry report.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
