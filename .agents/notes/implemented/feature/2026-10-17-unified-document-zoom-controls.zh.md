# Agent Note: 统一文档缩放控件

Status: implemented

[English](2026-10-17-unified-document-zoom-controls.md) | 中文

## 问题

PDF 与转换后的 Office 预览之前只按适合宽度渲染，图片预览则完全没有缩放能力。上游统一了这个面：一套控件、一个 scrollport、一个偏好模型，由 PDF、转换 Office、位图与 SVG 四种预览体共享。

## 决策

`ui-workbench` 内新增 `zoom` 层，提供 `ZoomViewport`、`ZoomControls` 与共享的 `ZoomPreference` 模型（`fit-width` 或 25%–400% 的固定缩放、25% 步进，预设为适合宽度、25%、50%、100%、150%、200%）。`ZoomViewport` 自带 scrollport，固定缩放在文档面内部滚动、不干扰文件/文本滚动器；`fit-width` 跟随面板尺寸变化，但不会把小于面板的内容放大。PDF 的 100% 指 96-DPI 页面尺寸，图片的 100% 指固有 CSS 像素宽度。Ctrl+滚轮与触控板捏合以指针为锚点实时缩放。

缩放偏好存放在所在 tab 的 `view` 对象上——文档用 `pdfView.zoom`，图片用 `fileView.zoom`——因此偏好在隐藏体重挂载后保留、随 tab 关闭消失，与本 fork 的 tab 持有 view 状态一致，替代上游的独立 store。由于懒加载的 `client.pdf.js` chunk 无法同步 require 与入口共享的模块（模块系统对 `require` 边不做 async 解析），`WorkspaceDocumentPreview` 通过 props 向 `PdfBody` 传入 `ZoomViewport` 与 surface class；PDF 页面经临时 canvas 渲染，在手势稳定后按 device-pixel-ratio 乘以缩放比例重发，旧位图保留到替换完成。

`WorkspaceFilePreview` 在尝试文本读取前先按图片扩展名分派：图片文件直接读字节——SVG 这类可被文本解码的载荷仍须渲染为图片而非源码文本。图片保持单个 `<img>`（保住动图连续性）,SVG 保留 [文档预览操作](../architecture/2026-09-08-document-preview-operations.zh.md) 记录的 `data:` URL 惰性渲染上下文。文本、Markdown、HTML 与表格预览不提供缩放控件。控件仅在精细指针设备上、指针进入底部 72 CSS 像素时显现，在悬停、焦点、菜单打开或手势期间保持可见，离开 420 ms 后隐藏；粗指针设备常驻可见。

## 备选方案

**上游的独立缩放 store。** 上游把偏好放在经 `useTabInfo` 到达的 per-tab store。本 fork 已为每个文件 tab 提供 tab 生命周期持有的可变 `view` 记录，写 `view.zoom` 语义等同，不必给 workbench 增加第二条 store 通道。

**让 PDF chunk 直接导入缩放层。** 静态导入边会让 rolldown 拆出共享 `client.ZoomViewport` chunk，入口再以同步 require 引用它，模块系统无法满足。经 props 注入使 chunk 边界保持原样。

**让 SVG 走文本 reader 的 `not-text` 回退。** 该回退服务于未识别的二进制载荷；让已知图片扩展名走一次必然失败的读取会多一次往返并掩盖图片意图。扩展名分派直接选择字节 reader，回退仍保留给未映射的二进制文件。

## 影响

- `packages/client/ui-workbench/src/client/zoom/` 承载共享层；`PdfBody` 与 `PreviewImage` 是两个消费方。
- `WorkspaceFileTab` 新增 `pdfView.zoom`/`fileView.zoom` 与本地化缩放文案；`document.ts` reader 契约不变。
- Web e2e 覆盖 Office 缩放（显隐、固定缩放、横向滚动、文本层存活、恢复适合宽度、设备像素渲染）与工作区图片缩放（固有尺寸、200%/100% 固定缩放、scrollport 溢出）。

## 验证

`zoom-viewport`、`pdf-body`、`workspace-preview`、`workspace-reload` client spec 覆盖 store、控件、重绘、分派与 reload 栅栏；`workspace-office` 与 `workspace-files` e2e 走真实组合。Typecheck、oxlint、翻译配对与 `git diff --check` 均通过。
