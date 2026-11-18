---
description: "已授权的延迟 Office 渲染、转换与重算，结果有界。"
kind: "subsystem-reference"
---

# Office Kit

[English](office-kit.md) | 中文

## 概述

[Office Kit 提供方](../../packages/document/office-kit/README.zh.md)提供 `ctx.officeKit`：`convert()` 将 Office 文档渲染为 PDF，`renderImages()` 将选定的页面、幻灯片或工作表区域栅格化为 PNG，`convertTo()` 保存格式转换结果，`recalculate()` 保存刷新公式结果后的工作簿。调用方负责源授权；提供方负责有界准入、共享转换、私有临时文件、按所有者划分的工作区外输出存储及引擎清理。

## 请求与结果

`OfficeKitRequest` 提供 `OfficeExtension`、优先级、已授权的源键、版本、可选字节数，以及延迟的 `read(signal, maxBytes)`。PDF 预览接受 `doc`、`docx`、`xls`、`xlsx`、`ppt` 和 `pptx`；格式转换还接受 OpenDocument 输入，图像渲染还接受 OpenDocument 和 PDF 输入，重算接受工作簿。回调仅在准入后执行，可多读一个溢出哨兵字节。版本变化或输入超限会拒绝该操作。

`OfficeKitResult` 返回调用方拥有的 PDF 字节、缺失字体、内容缓存键及转换器代次。`OfficeImagesResult` 按文档顺序返回图像，并给出文档页数与分辨率。`OfficeFileResult` 返回已保存文件在提供方按所有者划分的输出存储中的 Host 绝对路径与大小。`OfficeSourceKey`、`OfficeKitKey` 和 `OfficeKitGeneration` 是不透明的品牌身份，调用方不得解析。取消以其原因为拒绝结果；`OfficeKitError` 对转换及资源失败分类。

## 授权预览

[ApiProxy](../../packages/host/apiproxy/README.zh.md)在会话既有运行节点上公开 `workspaceFiles.renderOffice`。它复用文件授权、有界版本校验读取、取消及读后检查。传输结果仅包含源工作区相对路径、新鲜度版本、PDF 字节、缺失字体及代次。不要求 Agent 回合或会话事件。

[Workbench](../../packages/client/ui-workbench/README.zh.md)负责文件标签、源元数据、PDF Worker 生命周期及字体提示。命中转换缓存仍须通过内容授权。[适配决定](../../.agents/notes/implemented/architecture/2026-09-23-authorized-office-preview.zh.md)说明唯一资源所有者的原因。

## 引擎与容量

独立发布的 LibreOffice kit 负责引擎资源与平台选择。缺少必需资源时失败；提供方不在运行时下载引擎。包 README 负责配置默认值和准入限制。原生及 WASM 运行需要各自的真实平台证据。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
