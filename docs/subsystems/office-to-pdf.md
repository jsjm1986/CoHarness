---
description: "Authorized deferred Office conversion and bounded PDF results."
kind: "subsystem-reference"
---

# Office to PDF

English | [中文](office-to-pdf.zh.md)

## Summary

The [converter](../../packages/document/office-to-pdf/README.md) provides `ctx.officeToPdf.convert()`. Callers own source authorization; the provider owns bounded admission, shared conversion, private scratch files, and engine cleanup.

## Requests and results

`OfficeToPdfRequest` supplies an `OfficeExtension`, priority, authorized source key, version, optional byte size, and a deferred `read(signal, maxBytes)`. Supported extensions are `doc`, `docx`, `xls`, `xlsx`, `ppt`, and `pptx`. The callback runs only after admission and may read one overflow sentinel byte. A changed version or oversized input rejects conversion.

`OfficeToPdfResult` returns caller-owned PDF bytes, missing fonts, a content cache key, and converter generation. `OfficeSourceKey`, `OfficeToPdfKey`, and `OfficeToPdfGeneration` are opaque branded identities. Callers must not parse them. Cancellation rejects with its reason; `OfficeToPdfError` classifies conversion and resource failures.

## Authorized preview

[ApiProxy](../../packages/host/apiproxy/README.md) exposes `workspaceFiles.renderOffice` on the Session's existing runtime. It reuses file authorization, bounded version-checked reads, cancellation, and post-read checks. The wire result contains only the workspace-relative source path, freshness version, PDF bytes, missing fonts, and generation. No Agent turn or Session event is required.

[Workbench](../../packages/client/ui-workbench/README.md) owns the file tab, source metadata, PDF worker lifetime, and font notices. Conversion cache hits still require content authorization. The [adaptation decision](../../.agents/notes/implemented/architecture/2026-09-23-authorized-office-preview.md) explains the single resource owner.

## Engine and capacity

The independently published LibreOffice kit owns engine assets and platform selection. Missing required assets fail; the provider does not download an engine at runtime. The package README owns configuration defaults and admission limits. Native and WASM operation require separate real-platform evidence.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxofficetopdf--officetopdf"></a>

### `ctx.officeToPdf` — `OfficeToPdf`

A provider lifetime owns all converters, queued calls, and temporary files.

```ts cordis-catalog
/**
 * Convert Office bytes without modifying the source or writing Session events.
 * @param request - authorized metadata and deferred bounded source read.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
 * @throws {OfficeToPdfError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
 */
convert(request: OfficeToPdfRequest, signal?: AbortSignal): Promise<OfficeToPdfResult>
```

Source: [`packages/document/office-to-pdf/src/index.ts`](../../packages/document/office-to-pdf/src/index.ts)
<!-- END GENERATED cordis-surface -->
