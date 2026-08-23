# Agent Note: Build-time plugin surface and command measurement gates

Status: implemented

English | [中文](2026-08-23-plugin-surface-and-performance-gates.zh.md)

## Problem

The repository uses the phrase “everything is a plugin” for replaceable runtime capabilities, while bootstrap code, static browser libraries, protocol packages, and platform carriers intentionally remain outside the Loader tree. The distinction was not reported by one deterministic gate, and performance measurements were easy to mix with correctness tests or compare across different artifacts.

## Decision

`verify-plugin-surfaces` derives a stable build-time partition from every workspace package manifest, tree-external plugin manifest, client build preset, Bundle patch file, and the Web composition. It verifies dynamic versus static client declarations, including browser faces housed outside `packages/client`, workspace and tree-external Bundle patch targets, the approved immediate-prefetch list, and the production client-HMR switch. It emits counts without adding runtime metadata. `perf:command` measures an external command directly with explicit warmups, recorded runs, sorted samples, median, and nearest-rank P95; it never instruments product code or invokes a shell.

The architecture and development references point contributors to these two commands. The client-package gate applies browser mode and dependency checks to every dynamic client declaration, including API, registry, and extension packages outside `packages/client`. `verify-cordis-config` also resolves bare plugin rows in tree-external Bundle patches against the Bundle's declared dependencies or peers. Performance measurements remain a separate lane from correctness tests and carry the command, Node version, platform, and architecture in their output so baselines cannot silently mix artifacts.

## Alternatives considered

**Add a runtime tier field to every package.** Rejected because the tier is a build and composition fact; carrying it into manifests consumed by the process would add metadata without improving runtime behavior.

**Put timing assertions in ordinary unit tests.** Rejected because host scheduling and filesystem variance make correctness tests noisy; dedicated measurements can use repeated samples and explicit baselines.

**Classify packages by directory name only.** Rejected because dual-face packages, static client presets, and Bundle declarations cross directory boundaries; the verifier reads the manifests and build configuration that actually control loading.

## Consequences

The runtime retains the existing plugin and module paths, while CI gains a deterministic surface report and a reusable measurement entry point. Adding an immediate browser row or changing a Bundle declaration now requires the surface gate to explain the new composition. A measurement result is evidence, not a promise of a fixed latency; a reviewed baseline and a separately chosen budget remain necessary before a performance lane becomes blocking.

The same change keeps client layering honest without adding a hot-path tax. Type-only projections are erased and therefore do not create browser module requests; the domain gate allows those references while rejecting live sibling-domain imports. Runtime scope, notification, queue, image decoration, and conversation projection helpers live in shared client files, so the assembled UI pays one implementation cost and remains replaceable through the owning plugin.
