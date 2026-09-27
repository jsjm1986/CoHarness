---
description: "已授权的延迟 Office 转换与有界 PDF 结果。"
kind: "subsystem-reference"
---

# Office 转 PDF

[English](office-to-pdf.md) | 中文

## 概述

[转换器](../../packages/document/office-to-pdf/README.zh.md)提供 `ctx.officeToPdf.convert()`。调用方负责源授权；提供方负责有界准入、共享转换、私有临时文件及引擎清理。

## 请求与结果

`OfficeToPdfRequest` 提供 `OfficeExtension`、优先级、已授权的源键、版本、可选字节数，以及延迟的 `read(signal, maxBytes)`。支持的扩展名为 `doc`、`docx`、`xls`、`xlsx`、`ppt` 和 `pptx`。回调仅在准入后执行，可多读一个溢出哨兵字节。版本变化或输入超限会拒绝转换。

`OfficeToPdfResult` 返回调用方拥有的 PDF 字节、缺失字体、内容缓存键及转换器代次。`OfficeSourceKey`、`OfficeToPdfKey` 和 `OfficeToPdfGeneration` 是不透明的品牌身份，调用方不得解析。取消以其原因为拒绝结果；`OfficeToPdfError` 对转换及资源失败分类。

## 授权预览

[ApiProxy](../../packages/host/apiproxy/README.zh.md)在会话既有运行节点上公开 `workspaceFiles.renderOffice`。它复用文件授权、有界版本校验读取、取消及读后检查。传输结果仅包含源工作区相对路径、新鲜度版本、PDF 字节、缺失字体及代次。不要求 Agent 回合或会话事件。

[Workbench](../../packages/client/ui-workbench/README.zh.md)负责文件标签、源元数据、PDF Worker 生命周期及字体提示。命中转换缓存仍须通过内容授权。[适配决定](../../.agents/notes/implemented/architecture/2026-09-23-authorized-office-preview.zh.md)说明唯一资源所有者的原因。

## 引擎与容量

独立发布的 LibreOffice kit 负责引擎资源与平台选择。缺少必需资源时失败；提供方不在运行时下载引擎。包 README 负责配置默认值和准入限制。原生及 WASM 运行需要各自的真实平台证据。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
