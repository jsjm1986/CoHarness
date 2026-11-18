---
description: "Authorized deferred Office rendering, conversion, and recalculation with bounded results."
kind: "subsystem-reference"
---

# Office Kit

English | [中文](office-kit.zh.md)

## Summary

The [Office Kit provider](../../packages/document/office-kit/README.md) provides `ctx.officeKit`: `convert()` renders an Office document to PDF, `renderImages()` rasterizes selected pages, slides, or worksheet areas to PNG, `convertTo()` saves a format conversion, and `recalculate()` saves a workbook with refreshed formula results. Callers own source authorization; the provider owns bounded admission, shared conversion, private scratch files, an owner-scoped output store, and engine cleanup.

## Requests and results

`OfficeKitRequest` supplies an `OfficeExtension`, priority, authorized source key, version, optional byte size, and a deferred `read(signal, maxBytes)`. PDF previews accept `doc`, `docx`, `xls`, `xlsx`, `ppt`, and `pptx`; format conversion also accepts OpenDocument inputs, image rendering also accepts OpenDocument and PDF inputs, and recalculation accepts workbooks. The callback runs only after admission and may read one overflow sentinel byte. A changed version or oversized input rejects the operation.

`OfficeKitResult` returns caller-owned PDF bytes, missing fonts, a content cache key, and converter generation. `OfficeImagesResult` returns images in document order with the document page count and resolution. `OfficeFileResult` returns the saved file's absolute Host path and size in the provider's owner-scoped output store. `OfficeSourceKey`, `OfficeKitKey`, and `OfficeKitGeneration` are opaque branded identities. Callers must not parse them. Cancellation rejects with its reason; `OfficeKitError` classifies conversion and resource failures.

## Authorized preview

[ApiProxy](../../packages/host/apiproxy/README.md) exposes `workspaceFiles.renderOffice` on the Session's existing runtime. It reuses file authorization, bounded version-checked reads, cancellation, and post-read checks. The wire result contains only the workspace-relative source path, freshness version, PDF bytes, missing fonts, and generation. No Agent turn or Session event is required.

[Workbench](../../packages/client/ui-workbench/README.md) owns the file tab, source metadata, PDF worker lifetime, and font notices. Conversion cache hits still require content authorization. The [adaptation decision](../../.agents/notes/implemented/architecture/2026-09-23-authorized-office-preview.md) explains the single resource owner.

## Engine and capacity

The independently published LibreOffice kit owns engine assets and platform selection. Missing required assets fail; the provider does not download an engine at runtime. The package README owns configuration defaults and admission limits. Native and WASM operation require separate real-platform evidence.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxofficekit--officekit"></a>

### `ctx.officeKit` — `OfficeKit`

A provider lifetime owns all converters, queued calls, and temporary files.

```ts cordis-catalog
/**
 * Convert Office bytes to PDF without modifying the source or writing Session events.
 * @param request - authorized metadata and deferred bounded source read.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
 * @throws {OfficeKitError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
 */
async convert(request: OfficeKitRequest, signal?: AbortSignal): Promise<OfficeKitResult>

/**
 * Render selected pages, slides, or worksheet areas of one document as PNG images. Requests share the admission
 * queue, concurrency, source-byte reservation, and cache with previews, and run at foreground priority.
 * @param request - authorized metadata, deferred bounded source read, selection, and complete-result limits.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns caller-owned images in document order whose count, per-image size, and total bytes satisfy the limits.
 * @throws {OfficeKitError} `invalid-request` for a selection the engine rejects, `output-too-large` when the
 * selection exceeds a limit, and the other conversion codes; cancellation rejects with its reason.
 */
async renderImages(request: OfficeImagesRequest, signal?: AbortSignal): Promise<OfficeImagesResult>

/**
 * Convert one document to another format at foreground priority, sharing admission, concurrency, and cache with
 * previews, and save the result in the provider's output store.
 * @param request - authorized metadata, deferred bounded source read, target format, and output owner and name.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns the saved file's absolute Host path and size; the file is deleted after `outputRetentionMs`, when older
 * outputs need `maxOutputStoreBytes`, when the Session whose id is `output.owner` is disposed, or when the provider is disposed.
 * @throws {OfficeKitError} `invalid-request` for a format or sheet the engine rejects and the other conversion
 * codes; cancellation rejects with its reason.
 */
async convertTo(request: OfficeConversionRequest, signal?: AbortSignal): Promise<OfficeFileResult>

/**
 * Recalculate every formula of one workbook at foreground priority and save formulas with refreshed cached results, sharing admission,
 * concurrency, and cache with previews, and save the workbook in the provider's output store. This does not validate
 * formulas or business data.
 * @param request - authorized workbook metadata, deferred bounded source read, output format, and output owner and name.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns the saved workbook's absolute Host path and size, retained like {@link convertTo} outputs.
 * @throws {OfficeKitError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
 */
async recalculate(request: OfficeRecalculationRequest, signal?: AbortSignal): Promise<OfficeFileResult>
```

Source: [`packages/document/office-kit/src/index.ts`](../../packages/document/office-kit/src/index.ts)
<!-- END GENERATED cordis-surface -->
