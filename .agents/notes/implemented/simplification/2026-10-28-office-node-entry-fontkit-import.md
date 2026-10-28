# Agent Note: Office Node entry fontkit loading

Status: implemented

English | [中文](2026-10-28-office-node-entry-fontkit-import.zh.md)

## Problem

Importing the Office provider loads the kit's Node API before a document needs conversion. Kit 0.1.1 retains a bare fontkit import in this entry without using any fontkit value. Each short-lived font and conversion Worker imports its own parser, so this extra module graph consumes startup time and memory in the Host process.

Two alternating pairs of fresh plain-Node processes on macOS ARM64 import the built provider in 26.04 ms versus 5.19 ms with this import omitted. The corresponding import-window heap-used increases are 7.97 MB and 1.42 MB, with module namespaces retained and no forced GC. These small samples establish a startup candidate, not a conversion-speed or total preview-latency claim.

## Decision

A [version-scoped pnpm patch](../../../../patches/@deepseek-ai__libreoffice-kit@0.1.1.patch) removes only `import "fontkit";` from `@deepseek-ai/libreoffice-kit@0.1.1/lib/index.js`. pnpm's `patchedDependencies` and lockfile own installation of this change. Both Worker files, parser dependencies, native payloads, font discovery, cache validation, conversion limits and cleanup retain their existing implementation.

The [independent kit decision](../architecture/2026-09-14-independent-libreoffice-kit.md) continues to own engine and API releases; the [shared font metadata decision](../architecture/2026-10-26-local-runtime-office-font-metadata.md) continues to own cross-runtime metadata reuse. This patch adds no engine lifetime, font cache or Session authorization owner. An upstream package that removes this entry import allows the application patch to be retired after the same qualification.

## Alternatives considered

**Make metadata inspection asynchronous to load fontkit only after a cache miss.** This changes the scan's execution throughout its callers without demonstrated conversion gains. The entry-only change leaves that scan intact.

**Remove fontkit from the package dependency closure.** Both real Workers use its parser; omitting the dependency breaks cold font inspection and glyph matching.

**Keep an engine resident in each Runtime.** The [font metadata decision](../architecture/2026-10-26-local-runtime-office-font-metadata.md) rejects the idle engine memory cost. Startup module loading does not require a retained engine.

## Consequences

Fresh provider imports avoid the unused main-thread parser graph. Real conversion continues to load fontkit in both Workers and start the selected engine. Conversion and browser readiness remain separate measurements.

Qualification retains real source reads, native conversion, PDF bytes and cleanup. Private empty-cache and corrupt-cache native smokes exercise both variants; module-evaluation observations retain both Worker parser imports while removing the main-thread import. Text, page count and rendered pixels are compared by synthetic fixture rather than by PDF hashes that include engine metadata. Package upgrades require reviewing or removing the exact-version patch instead of silently carrying it forward.
